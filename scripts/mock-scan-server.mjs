#!/usr/bin/env node
// Tiny local stand-in for ora's public scan API, for manual CLI testing without
// burning the live rate limit (10 scans/min/IP):
//
//   node scripts/mock-scan-server.mjs [port]         # default 8799
//   ORA_API_URL=http://localhost:8799 node dist/main.cjs scan https://stripe.com
//
// Serves:
//   GET /api/scan/stream?domain=X  data-only SSE: progress events, scan_complete
//                                  (result nested under `result`), then summary_ready
//   GET /api/score/:domain         the same ScanResult as plain JSON
//
// Drop a real captured ScanResult at scripts/fixtures/score.json to serve that
// instead of the built-in sample.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2] ?? 8799);

const SAMPLE = {
	domain: "stripe.com",
	url: "https://stripe.com",
	score: 71,
	grade: "B",
	analysisStatus: "complete",
	pendingChecks: [],
	agenticSummary:
		"Stripe offers strong developer resource discoverability, but lacks an OpenAPI specification and a markdown sitemap.",
	layers: [
		{
			id: "discovery",
			name: "Discovery",
			score: 14,
			maxScore: 20,
			checks: [
				{
					id: "llms-txt",
					name: "llms.txt",
					status: "pass",
					score: 10,
					maxScore: 10,
					details: "found (2 KB)",
				},
				{
					id: "sitemap-md",
					name: "sitemap.md",
					status: "fail",
					score: 0,
					maxScore: 6,
					details: "status 404",
					recommendation: "Publish /sitemap.md listing your key pages as markdown links",
					estScoreGain: 2.4,
				},
				{
					id: "robots-txt",
					name: "robots.txt",
					status: "warning",
					score: 2,
					maxScore: 4,
					details: "partially restricted for AI crawlers",
					recommendation: "Allow AI crawlers (GPTBot, ClaudeBot, PerplexityBot) in robots.txt",
					estScoreGain: 1.2,
				},
				{
					id: "mcp",
					name: "MCP server",
					status: "na",
					score: 0,
					maxScore: 2,
					details: "not applicable for this URL kind",
				},
			],
		},
		{
			id: "access",
			name: "Access",
			score: 12,
			maxScore: 15,
			checks: [
				{
					id: "markdown",
					name: "Markdown content",
					status: "pass",
					score: 8,
					maxScore: 8,
					details: "text/markdown served to agents",
				},
				{
					id: "openapi",
					name: "OpenAPI spec",
					status: "fail",
					score: 0,
					maxScore: 7,
					details: "no /openapi.json or /openapi.yaml found",
					recommendation: "Publish an OpenAPI specification at a well-known path",
					estScoreGain: 3.1,
				},
			],
		},
	],
};

function loadResult() {
	try {
		const p = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "score.json");
		return JSON.parse(readFileSync(p, "utf8"));
	} catch {
		return SAMPLE;
	}
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
		const roster = result.layers.flatMap((l) => l.checks.map((c) => c.id));
		res.write(sse({ type: "kind_detecting" }));
		await sleep(150);
		res.write(sse({ type: "kind_detected", kind: "domain" }));
		await sleep(150);
		res.write(sse({ type: "scan_init", checkRoster: roster, layerMaxScores: {} }));
		res.write(sse({ type: "discovery_phase", label: "Crawling entry points…" }));
		for (const [i, id] of roster.entries()) {
			await sleep(120);
			res.write(sse({ type: "check_complete", checkName: id, status: "pass", index: i }));
		}
		await sleep(150);
		res.write(sse({ type: "scan_complete", result }));
		await sleep(400); // the summary really does arrive after scan_complete
		res.write(sse({ type: "summary_ready", agenticSummary: result.agenticSummary }));
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
	console.log(`mock ora scan API on http://localhost:${PORT}`);
	console.log(
		`try: ORA_API_URL=http://localhost:${PORT} node dist/main.cjs scan https://stripe.com`,
	);
});
