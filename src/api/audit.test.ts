import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditScanResult } from "../contract";
import { resetContractWarning } from "../contract";
// Captured from a real `GET /api/scan/stream?domain=example.com&format=audit`
// terminal event against contract 1.8.0 (2026-08-13). Real shape, not
// hand-rolled - tests derive variations from it with explicit deltas.
import realAuditScan from "./__fixtures__/audit-scan.json";
import { performAudit } from "./audit";

const FIXTURE = realAuditScan as unknown as AuditScanResult;

// The scan stream is data-only SSE: every block is just `data: {json}` with a
// `type` field inside — no `event:` names.
const scanStream = (events: unknown[]): Response =>
	new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});

const asJson = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const settled = (extra: Partial<AuditScanResult> = {}): AuditScanResult => ({
	...FIXTURE,
	...extra,
});

describe("performAudit", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		resetContractWarning();
	});

	it("requests the audit format and resolves with the raw payload", async () => {
		const seen: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				seen.push(String(url));
				return scanStream([
					{ type: "kind_detected", kind: "domain" },
					{ type: "scan_complete", result: settled() },
				]);
			}),
		);

		const { result } = await performAudit("example.com");
		expect(result.score).toBe(FIXTURE.score);
		expect(result.contractVersion).toBe(FIXTURE.contractVersion);
		expect(result.topFixes.map((f) => f.id)).toEqual(FIXTURE.topFixes.map((f) => f.id));
		expect(seen).toEqual(["https://ora.ai/api/scan/stream?domain=example.com&format=audit"]);
	});

	it("threads the freshness flags onto the stream URL", async () => {
		const seen: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				seen.push(String(url));
				return scanStream([{ type: "scan_complete", result: settled() }]);
			}),
		);

		await performAudit("example.com", { force: true, maxAgeSeconds: 7200, ephemeral: true });
		const url = new URL(seen[0]);
		expect(url.searchParams.get("format")).toBe("audit");
		expect(url.searchParams.get("force")).toBe("1");
		expect(url.searchParams.get("ephemeral")).toBe("1");
		expect(url.searchParams.get("maxAgeSeconds")).toBe("7200");
	});

	it("keeps reading past scan_complete to pick up the summary_ready verdict", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				scanStream([
					{ type: "scan_complete", result: settled() },
					{ type: "summary_ready", agenticSummary: "Solid entry points, weak specs." },
				]),
			),
		);

		const { verdict } = await performAudit("example.com");
		expect(verdict).toBe("Solid entry points, weak specs.");
	});

	it("warns on stderr once when the payload reports a newer contract", async () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const [major, minor] = FIXTURE.contractVersion.split(".").map(Number);
		const newer = `${major}.${minor + 1}.0`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				scanStream([{ type: "scan_complete", result: { ...settled(), contractVersion: newer } }]),
			),
		);

		await performAudit("example.com");
		const warnings = write.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(newer));
		expect(warnings).toHaveLength(1);
		write.mockRestore();
	});

	it("reports one-line progress through the phases of a scan", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				scanStream([
					{ type: "kind_detecting" },
					{ type: "kind_detected", kind: "domain" },
					{ type: "scan_init", checkRoster: ["a", "b"], layerMaxScores: {} },
					{ type: "discovery_phase", label: "Crawling entry points…" },
					{ type: "check_complete", checkName: "llms.txt" },
					{ type: "check_complete", checkName: "robots.txt" },
					{ type: "scan_complete", result: settled() },
				]),
			),
		);

		const lines: string[] = [];
		await performAudit("example.com", { progress: (line) => lines.push(line) });
		expect(lines[0]).toBe("Auditing example.com with ora");
		expect(lines).toContain("Detecting URL kind…");
		expect(lines).toContain("Detected domain, scanning…");
		expect(lines).toContain("Crawling entry points…");
		// determinate bar once the roster size is known
		expect(lines.find((l) => l.includes("1/2"))).toMatch(/█+░+ 1\/2 · llms\.txt/);
		expect(lines.at(-1)).toBe("Finishing up…");
	});

	it("rejects when the stream closes without scan_complete", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => scanStream([{ type: "check_complete" }, { type: "layer_complete" }])),
		);
		await expect(performAudit("example.com")).rejects.toThrow(/ended before completing/i);
	});

	it("polls the score endpoint in audit format while analysis is partial", async () => {
		const halfway = settled({ analysisStatus: "partial", pendingChecks: ["crawl"] });
		const finished = settled({ score: 83 });
		const seen: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				seen.push(String(url));
				return seen.length === 1
					? scanStream([{ type: "scan_complete", result: halfway }])
					: asJson(finished);
			}),
		);

		const { result } = await performAudit("example.com", { pollEveryMs: 0 });
		expect(result.score).toBe(83);
		expect(result.analysisStatus).toBe("complete");
		expect(seen).toHaveLength(2);
		expect(seen[1]).toBe("https://ora.ai/api/score/example.com?format=audit");
	});

	it("gives up polling once the analysis is marked stuck", async () => {
		const halfway = settled({ analysisStatus: "partial", pendingChecks: ["crawl"] });
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(scanStream([{ type: "scan_complete", result: halfway }]))
			.mockResolvedValueOnce(asJson(settled({ analysisStatus: "stuck" })));
		vi.stubGlobal("fetch", fetchMock);

		const { result } = await performAudit("example.com", { pollEveryMs: 0, pollLimit: 25 });
		expect(result.analysisStatus).toBe("stuck");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("explains the rate limits on 429", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "42" } })),
		);
		await expect(performAudit("example.com")).rejects.toThrow(/rate limit.*42s/i);
	});

	it("surfaces the server's message on a 4xx response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => asJson({ error: "Bad", message: "Domain failed validation" }, 400)),
		);
		await expect(performAudit("not a domain")).rejects.toThrow(/Domain failed validation/);
	});

	it("times out when the stream goes silent", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init?: { signal?: AbortSignal }) => {
				// Connects but never emits; only the idle watchdog can end this.
				const silent = new ReadableStream<Uint8Array>({
					start(controller) {
						init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
					},
				});
				return new Response(silent, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}),
		);
		await expect(performAudit("example.com", { idleMs: 40 })).rejects.toThrow(/timed out/i);
	});
});
