import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { fetchSkill, fetchSkillIndex, SkillApiError } from "../api/skills";
import { EXIT } from "./audit";

export interface SkillCommandInput {
	/** Skill name; omitted = list the registry. */
	name?: string;
	/** Write <dir>/<name>/SKILL.md instead of printing. */
	install: boolean;
	/** Install directory (default .claude/skills). */
	dir?: string;
	json: boolean;
}

const DEFAULT_INSTALL_DIR = ".claude/skills";

function wrap(text: string, width: number, indent: string): string[] {
	const rows: string[] = [];
	let row = "";
	for (const word of text.split(/\s+/)) {
		if (row && `${row} ${word}`.length > width) {
			rows.push(indent + row);
			row = word;
		} else {
			row = row ? `${row} ${word}` : word;
		}
	}
	if (row) rows.push(indent + row);
	return rows;
}

export async function skillCommand(input: SkillCommandInput): Promise<number> {
	try {
		if (!input.name) {
			const index = await fetchSkillIndex();
			if (input.json) {
				process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
				return EXIT.OK;
			}
			console.log("");
			for (const entry of index) {
				const digest = entry.digest ? pc.dim(`  ${entry.digest.slice(0, 19)}…`) : "";
				console.log(`  ${pc.bold(entry.name)}${digest}`);
				if (entry.description) {
					for (const row of wrap(entry.description, 76, "    ")) console.log(pc.dim(row));
				}
				console.log("");
			}
			console.log(pc.dim("  Install one with: ax skill <name> --install"));
			console.log("");
			return EXIT.OK;
		}

		const { entry, bytes } = await fetchSkill(input.name);
		if (input.install) {
			const dir = join(input.dir ?? DEFAULT_INSTALL_DIR, entry.name);
			mkdirSync(dir, { recursive: true });
			const path = join(dir, "SKILL.md");
			writeFileSync(path, bytes);
			console.log(`Installed ${entry.name} to ${path}`);
			if (entry.digest) console.log(pc.dim(`verified ${entry.digest}`));
			return EXIT.OK;
		}
		process.stdout.write(bytes);
		return EXIT.OK;
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		console.error(`Skill command failed: ${message}`);
		// An unknown name is a usage mistake; everything else is registry trouble.
		if (cause instanceof SkillApiError && message.includes("unknown skill")) return EXIT.USAGE;
		return EXIT.API;
	}
}
