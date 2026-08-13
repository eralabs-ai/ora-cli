#!/usr/bin/env node
// Tiny local stand-in for ora's public audit API, for manual CLI testing
// without burning the live rate limits (10 scans/min/IP, 30 scans/day):
//
//   node scripts/mock-scan-server.mjs [port]         # default 8799
//   ORA_API_URL=http://localhost:8799 node dist/main.cjs audit https://example.com
//
// Serves:
//   GET /api/scan/stream?domain=X&format=audit   data-only SSE: progress events,
//                                                scan_complete (audit payload nested
//                                                under `result`), then summary_ready
//   GET /api/score/:domain?format=audit          the same audit payload as plain JSON
//
// The payload is the checked-in real capture at src/api/__fixtures__/
// audit-scan.json (contract 1.8.0). Drop a newer capture at
// scripts/fixtures/audit.json to serve that instead. Pass &mock_cached=1 to
// exercise the freshness-hit path (terminal event only, cache provenance).

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2] ?? 8799);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SUMMARY =
	"Example.com has basic entity presence and bot accessibility, but lacks any public API surface or OpenAPI specification.";

function loadResult() {
	for (const p of [
		join(ROOT, "scripts", "fixtures", "audit.json"),
		join(ROOT, "src", "api", "__fixtures__", "audit-scan.json"),
	]) {
		try {
			return JSON.parse(readFileSync(p, "utf8"));
		} catch {
			// try the next candidate
		}
	}
	throw new Error("no audit fixture found");
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	const result = loadResult();

	if (url.pathname === "/api/scan/stream") {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		// A freshness-window hit is just kind_detected + the terminal event
		// carrying the cache provenance - mirror that when the caller does NOT
		// force, so the cached trailing line is testable locally.
		const cached =
			url.searchParams.get("mock_cached") === "1" && url.searchParams.get("force") !== "1";
		const roster = result.layers.flatMap((l) => l.checks.map((c) => c.id));
		res.write(sse({ type: "kind_detecting" }));
		await sleep(150);
		res.write(sse({ type: "kind_detected", kind: "domain" }));
		if (cached) {
			res.write(
				sse({
					type: "scan_complete",
					result: { ...result, servedFromCache: true, resultAgeSeconds: 2580 },
				}),
			);
			res.end();
			return;
		}
		await sleep(150);
		res.write(sse({ type: "scan_init", checkRoster: roster, layerMaxScores: {} }));
		res.write(sse({ type: "discovery_phase", label: "Crawling entry points…" }));
		for (const [i, id] of roster.entries()) {
			await sleep(30);
			res.write(sse({ type: "check_complete", checkName: id, status: "pass", index: i }));
		}
		await sleep(150);
		res.write(sse({ type: "scan_complete", result }));
		await sleep(400); // the summary really does arrive after scan_complete
		res.write(sse({ type: "summary_ready", agenticSummary: SUMMARY }));
		res.end();
		return;
	}

	if (url.pathname.startsWith("/api/score/")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(result));
		return;
	}

	res.writeHead(404, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
	console.log(`mock ora audit API on http://localhost:${PORT}`);
	console.log(
		`try: ORA_API_URL=http://localhost:${PORT} node dist/main.cjs audit https://example.com`,
	);
});
