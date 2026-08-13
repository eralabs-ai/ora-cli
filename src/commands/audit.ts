import { AuditApiError, type AuditOutcome, performAudit } from "../api/audit";
import { toReport } from "../report/model";
import { renderReport } from "../report/terminal";
import { spinner } from "../ui/spinner";

export interface AuditCommandInput {
	url: string;
	json: boolean;
	showSkipped: boolean;
	showPassing: boolean;
	/** Raw --min-score value; validated here so a bad value is a usage error. */
	minScore?: string;
	/** Raw --max-age value in seconds. */
	maxAge?: string;
	force: boolean;
}

/**
 * The documented exit-code contract (README + --help):
 *   0 success (and score >= --min-score when given)
 *   1 score below --min-score
 *   2 usage error (bad flags, malformed URL, cloudflared missing)
 *   3 API unreachable / timeout / rate limit exhausted
 */
export const EXIT = { OK: 0, BELOW_MIN_SCORE: 1, USAGE: 2, API: 3 } as const;

function parseIntFlag(
	raw: string | undefined,
	flag: string,
	min: number,
	max: number,
): { value?: number; error?: string } {
	if (raw === undefined) return {};
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) {
		return {
			error: `${flag} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw)}`,
		};
	}
	return { value };
}

/** Accepts bare domains and full URLs; rejects anything the API would 400 on sight. */
function normalizeTarget(raw: string): string | undefined {
	const target = raw.trim().replace(/\/+$/, "");
	if (!target || /\s/.test(target)) return undefined;
	try {
		const url = new URL(target.includes("://") ? target : `https://${target}`);
		if (!url.hostname.includes(".") && url.hostname !== "localhost") return undefined;
		return target;
	} catch {
		return undefined;
	}
}

export async function auditCommand(input: AuditCommandInput): Promise<number> {
	const target = normalizeTarget(input.url);
	if (!target) {
		console.error(`Not a scannable URL or domain: ${JSON.stringify(input.url)}`);
		return EXIT.USAGE;
	}
	const minScore = parseIntFlag(input.minScore, "--min-score", 0, 100);
	const maxAge = parseIntFlag(input.maxAge, "--max-age", 0, 86_400);
	for (const flag of [minScore, maxAge]) {
		if (flag.error) {
			console.error(flag.error);
			return EXIT.USAGE;
		}
	}

	const interactive = !input.json;
	if (interactive) spinner.start(`Auditing ${target} with ora`);

	let outcome: AuditOutcome;
	try {
		outcome = await performAudit(target, {
			progress: interactive ? (line) => spinner.update(line) : undefined,
			maxAgeSeconds: maxAge.value,
			force: input.force,
		});
	} catch (cause) {
		spinner.stop();
		console.error(`Audit failed: ${cause instanceof Error ? cause.message : String(cause)}`);
		return cause instanceof AuditApiError ? EXIT.API : EXIT.USAGE;
	}
	spinner.stop();

	const { result } = outcome;
	if (input.json) {
		// Raw contract passthrough: the payload exactly as ora served it.
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		for (const line of renderReport(toReport(outcome, target), {
			showSkipped: input.showSkipped,
			showPassing: input.showPassing,
		})) {
			console.log(line);
		}
	}

	if (minScore.value !== undefined) {
		if (result.mcpAuthRequired) {
			// Documented contract guidance: an auth-gated MCP scan is unscored -
			// its 0/F means "could not evaluate", so a gate must not fail on it.
			process.stderr.write(
				"--min-score skipped: the MCP handshake requires credentials, so the target is unscored\n",
			);
			return EXIT.OK;
		}
		if (result.score < minScore.value) {
			if (!input.json) {
				console.log(`  Score ${result.score} is below the required minimum ${minScore.value}\n`);
			}
			return EXIT.BELOW_MIN_SCORE;
		}
	}
	return EXIT.OK;
}
