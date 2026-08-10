import { errorBodyText, pause, watchdog } from "./shared";

// Client for ora's public agent-readiness scan. Uses the SSE endpoint
// (GET /api/scan/stream) rather than POST /api/scan: the synchronous variant
// has a ~30s hard cap and reliably times out on large or uncached sites,
// whereas the stream just keeps emitting while the scan works.

const PUBLIC_BASE = "https://ora.ai";
const STREAM_IDLE_MS = 60_000;
const POLL_EVERY_MS = 2_000;
const POLL_LIMIT = 45; // ≈90s of patience for async deep analysis
const BAR_CELLS = 14;

export type ScanCheckStatus = "pass" | "fail" | "warning" | "error" | "pending" | "na";

export interface ScanCheck {
	id: string;
	name: string;
	/** What the check inspects — not the remedy. */
	description?: string;
	status: ScanCheckStatus;
	score: number;
	maxScore: number;
	/** The observed finding. */
	details?: string;
	/** The remedy to apply. Absent from ora's OpenAPI spec, present in responses. */
	recommendation?: string;
	/** Estimated points recovered by fixing this check. */
	estScoreGain?: number;
}

export interface ScanLayer {
	id: string;
	name: string;
	description?: string;
	checks: ScanCheck[];
	score: number;
	maxScore: number;
}

export interface ScanResult {
	domain?: string;
	url?: string;
	finalUrl?: string;
	score: number;
	maxScore?: number;
	grade?: string;
	analysisStatus?: "complete" | "partial" | "stuck";
	pendingChecks?: string[];
	layers?: ScanLayer[];
	agenticSummary?: string;
	urlKind?: string;
	scannedAt?: string;
	durationMs?: number;
}

export interface ScanOptions {
	/** Receives one-line progress updates while the scan streams and polls. */
	progress?: (line: string) => void;
	/** Base URL override; otherwise $ORA_API_URL, otherwise https://ora.ai. */
	baseUrl?: string;
	/** Abort when the stream is silent for this long (default 60s). */
	idleMs?: number;
	pollEveryMs?: number;
	pollLimit?: number;
}

/**
 * Scan `target` and resolve with ora's full ScanResult. When the stream ends
 * with analysis still marked partial, keeps polling GET /api/score/{domain}
 * until it settles (complete or stuck) or the poll budget runs out.
 */
export async function performScan(target: string, options: ScanOptions = {}): Promise<ScanResult> {
	const base = (options.baseUrl ?? process.env.ORA_API_URL ?? PUBLIC_BASE).replace(/\/+$/, "");
	options.progress?.(`Scanning ${target} with ora`);

	let scan = await consumeScanStream(base, target, options);
	if (stillAnalyzing(scan)) scan = await awaitDeepAnalysis(base, scan, options);
	return scan;
}

// The stream is data-only SSE: `data: {json}` blocks separated by blank lines,
// no `event:` names. Every payload carries a `type` discriminator. Two of them
// matter beyond progress: `scan_complete` (ScanResult nested under `result`)
// and `summary_ready` (the one-line agentic verdict, generated after scoring —
// stopping at scan_complete would silently drop it).
async function consumeScanStream(
	base: string,
	target: string,
	options: ScanOptions,
): Promise<ScanResult> {
	const idleMs = options.idleMs ?? STREAM_IDLE_MS;
	const dog = watchdog(idleMs);
	const timeoutError = () =>
		new Error(`ora scan timed out — no progress for ${Math.round(idleMs / 1000)}s`);

	let res: Response;
	try {
		res = await fetch(`${base}/api/scan/stream?domain=${encodeURIComponent(target)}`, {
			headers: { accept: "text/event-stream" },
			signal: dog.signal,
		});
	} catch (cause) {
		dog.disarm();
		if (dog.tripped()) throw timeoutError();
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new Error(`ora scan request failed: ${detail}`);
	}

	if (res.status === 429) {
		dog.disarm();
		const wait = res.headers.get("retry-after");
		throw new Error(
			`ora rate limit exceeded (10 scans/min per IP)${wait ? ` — retry after ${wait}s` : ""}`,
		);
	}
	if (!res.ok || !res.body) {
		dog.disarm();
		throw new Error(`ora scan failed: ${await errorBodyText(res)}`);
	}

	const narrate = progressNarrator();
	const utf8 = new TextDecoder();
	let pending = "";
	let scan: ScanResult | undefined;
	let verdict: string | undefined;

	try {
		streaming: for await (const chunk of res.body) {
			dog.poke();
			pending = `${pending}${utf8.decode(chunk as Uint8Array, { stream: true })}`.replace(
				/\r\n?/g,
				"\n",
			);
			let cut = pending.indexOf("\n\n");
			while (cut !== -1) {
				const packet = joinDataLines(pending.slice(0, cut));
				pending = pending.slice(cut + 2);
				cut = pending.indexOf("\n\n");
				if (!packet) continue;
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(packet);
				} catch {
					continue;
				}
				const line = narrate(event);
				if (line) options.progress?.(line);
				if (event.type === "scan_complete" && event.result) {
					scan = event.result as ScanResult;
				} else if (event.type === "summary_ready" && typeof event.agenticSummary === "string") {
					verdict = event.agenticSummary;
				}
				// Bail as soon as both pieces are in hand; otherwise drain to the end
				// (the server closes shortly after, with or without a summary).
				if (scan && verdict) break streaming;
			}
		}
	} catch (cause) {
		if (dog.tripped()) throw timeoutError();
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new Error(`ora scan stream error: ${detail}`);
	} finally {
		dog.disarm();
		res.body.cancel().catch(() => {});
	}

	if (!scan) throw new Error("ora scan stream ended before completing");
	if (verdict && !scan.agenticSummary) scan.agenticSummary = verdict;
	return scan;
}

// Concatenate the data: lines of one SSE block, dropping one optional leading
// space per line (the scan stream never sends event: lines).
function joinDataLines(block: string): string {
	const collected: string[] = [];
	for (const row of block.split("\n")) {
		if (row.startsWith("data:")) collected.push(row.slice(5).replace(/^ /, ""));
	}
	return collected.join("\n");
}

// Turns raw stream events into spinner copy. The determinate bar is driven by
// `check_complete` events against the roster announced in `scan_init`;
// `check_start` is useless for progress because ora emits every start up
// front. Completions can also overshoot the roster, hence the clamp.
function progressNarrator(): (event: Record<string, unknown>) => string | undefined {
	let expected = 0;
	let finished = 0;
	let checkName = "";

	return (event) => {
		switch (event.type) {
			case "kind_detecting":
				return "Detecting URL kind…";
			case "kind_detected":
				return typeof event.kind === "string" ? `Detected ${event.kind}, scanning…` : undefined;
			case "scan_init":
				if (Array.isArray(event.checkRoster)) expected = event.checkRoster.length;
				return undefined;
			case "discovery_phase":
				return typeof event.label === "string" ? event.label : undefined;
			case "check_complete": {
				finished += 1;
				if (typeof event.checkName === "string") checkName = event.checkName;
				if (expected <= 0) return `Running checks… (${finished})`;
				const capped = Math.min(finished, expected);
				const cells = Math.min(BAR_CELLS, Math.max(0, Math.round((capped / expected) * BAR_CELLS)));
				const bar = `${"█".repeat(cells)}${"░".repeat(BAR_CELLS - cells)}`;
				return `${bar} ${capped}/${expected}${checkName ? ` · ${checkName}` : ""}`;
			}
			case "scan_complete":
				return "Finishing up…";
			default:
				return undefined;
		}
	};
}

function stillAnalyzing(scan: ScanResult): boolean {
	if (scan.analysisStatus === "complete" || scan.analysisStatus === "stuck") return false;
	if (scan.analysisStatus === "partial") return true;
	return (scan.pendingChecks?.length ?? 0) > 0;
}

async function awaitDeepAnalysis(
	base: string,
	first: ScanResult,
	options: ScanOptions,
): Promise<ScanResult> {
	const host = first.domain ?? hostOf(first.url);
	if (!host) return first;

	const scoreUrl = `${base}/api/score/${encodeURIComponent(host)}`;
	const every = options.pollEveryMs ?? POLL_EVERY_MS;
	const limit = options.pollLimit ?? POLL_LIMIT;
	let latest = first;

	for (let round = 0; round < limit && stillAnalyzing(latest); round++) {
		const left = latest.pendingChecks?.length ?? 0;
		options.progress?.(
			left ? `Analyzing… ${left} check${left === 1 ? "" : "s"} pending` : "Analyzing…",
		);
		await pause(every);
		try {
			const res = await fetch(scoreUrl, {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(15_000),
			});
			if (res.ok) latest = (await res.json()) as ScanResult;
		} catch {
			// transient hiccup — keep polling until the round budget is spent
		}
	}
	return latest;
}

function hostOf(url?: string): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}
