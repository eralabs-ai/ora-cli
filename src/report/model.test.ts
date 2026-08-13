import { describe, expect, it } from "vitest";
// Captured from a real audit-format terminal event (contract 1.8.0,
// example.com, 2026-08-13). Real shape - variations are explicit deltas.
import realAuditScan from "../api/__fixtures__/audit-scan.json";
import type { AuditScanResult } from "../contract";
import { toReport } from "./model";

const FIXTURE = realAuditScan as unknown as AuditScanResult;

const outcome = (extra: Partial<AuditScanResult> = {}, verdict?: string) => ({
	result: { ...FIXTURE, ...extra },
	verdict,
});

describe("toReport", () => {
	it("maps the payload without re-deriving interpretation", () => {
		const report = toReport(outcome({}, "A fine site."), "https://example.com");

		expect(report.target).toBe(FIXTURE.domain);
		expect(report.score).toBe(FIXTURE.score);
		// Grade comes from the API - there is no client-side rating scale.
		expect(report.grade).toBe(FIXTURE.grade);
		expect(report.summary).toBe("A fine site.");
		expect(report.reportUrl).toBe(FIXTURE.url);
		expect(report.sections).toHaveLength(FIXTURE.layers.length);
	});

	it("passes topFixes through in the server's order, untouched", () => {
		const report = toReport(outcome(), "example.com");
		expect(report.topFixes).toEqual(FIXTURE.topFixes);
	});

	it("counts pass/fail/skip per section like the payload says", () => {
		const report = toReport(outcome(), "example.com");
		for (const [i, layer] of FIXTURE.layers.entries()) {
			const section = report.sections[i];
			const counted = layer.checks.filter((c) => c.status !== "na" && c.status !== "pending");
			expect(section.total).toBe(counted.length);
			expect(section.passed).toBe(counted.filter((c) => c.status === "pass").length);
			expect(section.skipped).toBe(layer.checks.length - counted.length);
		}
	});

	it("carries specUrl and estScoreGain onto checks that have them", () => {
		const report = toReport(outcome(), "example.com");
		const flat = report.sections.flatMap((s) => s.checks);
		const withSpec = FIXTURE.layers.flatMap((l) => l.checks).filter((c) => c.specUrl);
		expect(withSpec.length).toBeGreaterThan(0);
		for (const raw of withSpec) {
			expect(flat.find((c) => c.id === raw.id)?.specUrl).toBe(raw.specUrl);
		}
	});

	it("hints only from recommendation, never from details", () => {
		const report = toReport(outcome(), "example.com");
		const flat = report.sections.flatMap((s) => s.checks);
		const raw = FIXTURE.layers.flatMap((l) => l.checks);
		for (const check of flat.filter((c) => !c.passed && !c.skipped)) {
			const source = raw.find((r) => r.id === check.id && r.status === check.status);
			if (check.hint) expect(check.hint).toBe(source?.recommendation);
		}
	});

	it("surfaces freshness provenance from a cache hit", () => {
		const report = toReport(
			outcome({ servedFromCache: true, resultAgeSeconds: 2580 } as Partial<AuditScanResult>),
			"example.com",
		);
		expect(report.cacheAgeSeconds).toBe(2580);
		expect(toReport(outcome(), "example.com").cacheAgeSeconds).toBeUndefined();
	});

	it("flags an auth-gated MCP result as unscored", () => {
		const report = toReport(
			outcome({ mcpAuthRequired: true, score: 0, grade: "F", layers: [], topFixes: [] }),
			"example.com",
		);
		expect(report.mcpAuthRequired).toBe(true);
		expect(report.topFixes).toEqual([]);
	});
});
