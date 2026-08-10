import { afterEach, describe, expect, it, vi } from "vitest";
import { type ScanResult, performScan } from "./scan";

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

const settled = (extra: Partial<ScanResult> = {}): ScanResult => ({
	domain: "acme.dev",
	score: 88,
	analysisStatus: "complete",
	pendingChecks: [],
	layers: [],
	...extra,
});

describe("performScan", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("resolves with the payload nested in scan_complete", async () => {
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

		const scan = await performScan("acme.dev");
		expect(scan.score).toBe(88);
		expect(seen).toEqual(["https://ora.ai/api/scan/stream?domain=acme.dev"]);
	});

	it("keeps reading past scan_complete to pick up summary_ready", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				scanStream([
					{ type: "scan_complete", result: settled() },
					{ type: "summary_ready", agenticSummary: "Solid entry points, weak specs." },
				]),
			),
		);

		const scan = await performScan("acme.dev");
		expect(scan.agenticSummary).toBe("Solid entry points, weak specs.");
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
		await performScan("acme.dev", { progress: (line) => lines.push(line) });
		expect(lines[0]).toBe("Scanning acme.dev with ora");
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
		await expect(performScan("acme.dev")).rejects.toThrow(/ended before completing/i);
	});

	it("polls the score endpoint while analysis is partial", async () => {
		const halfway = settled({ score: 51, analysisStatus: "partial", pendingChecks: ["crawl"] });
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

		const scan = await performScan("acme.dev", { pollEveryMs: 0 });
		expect(scan.score).toBe(83);
		expect(scan.analysisStatus).toBe("complete");
		expect(seen).toHaveLength(2);
		expect(seen[0]).toContain("/api/scan/stream");
		expect(seen[1]).toBe("https://ora.ai/api/score/acme.dev");
	});

	it("gives up polling once the analysis is marked stuck", async () => {
		const halfway = settled({ score: 40, analysisStatus: "partial", pendingChecks: ["crawl"] });
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(scanStream([{ type: "scan_complete", result: halfway }]))
			.mockResolvedValueOnce(asJson(settled({ score: 40, analysisStatus: "stuck" })));
		vi.stubGlobal("fetch", fetchMock);

		const scan = await performScan("acme.dev", { pollEveryMs: 0, pollLimit: 25 });
		expect(scan.analysisStatus).toBe("stuck");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("explains the public rate limit on 429", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "42" } })),
		);
		await expect(performScan("acme.dev")).rejects.toThrow(/rate limit.*42s/i);
	});

	it("surfaces the server's message on a 4xx response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => asJson({ error: "Bad", message: "Domain failed validation" }, 400)),
		);
		await expect(performScan("not a domain")).rejects.toThrow(/Domain failed validation/);
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
		await expect(performScan("acme.dev", { idleMs: 40 })).rejects.toThrow(/timed out/i);
	});
});
