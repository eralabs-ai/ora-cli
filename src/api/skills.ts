import { createHash } from "node:crypto";

// Client for ora's digest-bound skill registry at
// /.well-known/agent-skills/index.json. Skill content is NEVER bundled into
// this package - it is fetched from the registry and verified against the
// index's sha256 digest before it is printed or installed, so what lands on
// disk is provably the bytes ora published.

const PUBLIC_BASE = "https://ora.ai";

export class SkillApiError extends Error {}

export interface SkillEntry {
	name: string;
	type?: string;
	description?: string;
	/** Path or absolute URL to the SKILL.md. */
	url: string;
	/** `sha256:<hex>` over the exact SKILL.md bytes. */
	digest?: string;
}

export function resolveBase(baseUrl?: string): string {
	return (baseUrl ?? process.env.ORA_API_URL ?? PUBLIC_BASE).replace(/\/+$/, "");
}

export async function fetchSkillIndex(baseUrl?: string): Promise<SkillEntry[]> {
	const base = resolveBase(baseUrl);
	let res: Response;
	try {
		res = await fetch(`${base}/.well-known/agent-skills/index.json`, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
		});
	} catch (cause) {
		throw new SkillApiError(
			`could not reach the skill registry at ${base}: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
	if (!res.ok) throw new SkillApiError(`skill registry answered HTTP ${res.status}`);
	const body = (await res.json()) as { skills?: SkillEntry[] };
	if (!Array.isArray(body.skills)) throw new SkillApiError("skill registry index has no skills[]");
	return body.skills;
}

export function digestOf(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export interface FetchedSkill {
	entry: SkillEntry;
	/** The exact SKILL.md bytes, digest-verified against the index. */
	bytes: Uint8Array;
}

/**
 * Fetch one skill's SKILL.md and verify it against the index digest. A
 * mismatch is refused outright - never serve bytes the index does not vouch
 * for.
 */
export async function fetchSkill(name: string, baseUrl?: string): Promise<FetchedSkill> {
	const base = resolveBase(baseUrl);
	const index = await fetchSkillIndex(base);
	const entry = index.find((s) => s.name === name);
	if (!entry) {
		const known = index.map((s) => s.name).join(", ");
		throw new SkillApiError(`unknown skill ${JSON.stringify(name)} - the registry has: ${known}`);
	}

	const url = entry.url.startsWith("http") ? entry.url : `${base}${entry.url}`;
	let res: Response;
	try {
		res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	} catch (cause) {
		throw new SkillApiError(
			`could not fetch ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
	if (!res.ok) throw new SkillApiError(`skill fetch answered HTTP ${res.status} for ${url}`);
	const bytes = new Uint8Array(await res.arrayBuffer());

	if (entry.digest && digestOf(bytes) !== entry.digest) {
		throw new SkillApiError(
			`digest mismatch for ${name}: index says ${entry.digest}, served bytes hash to ${digestOf(bytes)} - refusing to use them`,
		);
	}
	return { entry, bytes };
}
