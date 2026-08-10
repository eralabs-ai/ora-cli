import { describe, expect, it } from "vitest";
import type { ScanResult } from "../api/scan";
import { type AuditCheck, ratingFor, sectionOf, toAuditReport } from "./model";

const SCAN: ScanResult = {
	domain: "acme.dev",
	url: "https://acme.dev",
	score: 82,
	grade: "B",
	analysisStatus: "complete",
	agenticSummary: "acme.dev greets agents well but hides its spec.",
	pendingChecks: [],
	layers: [
		{
			id: "access",
			name: "Agent Access",
			score: 12,
			maxScore: 24,
			checks: [
				{
					id: "gateway",
					name: "agent gateway",
					description: "Serves markdown to agent user-agents",
					status: "pass",
					score: 10,
					maxScore: 10,
					details: "content negotiated",
				},
				{
					id: "mirror",
					name: "markdown mirror",
					description: "A .md twin exists for every page",
					status: "fail",
					score: 0,
					maxScore: 6,
					details: "0 of 12 pages mirrored",
					recommendation: "Serve a .md variant of each documentation page",
					estScoreGain: 1.8,
				},
				{
					id: "mcp",
					name: "mcp endpoint",
					description: "Advertises an MCP server",
					status: "na",
					score: 0,
					maxScore: 4,
					details: "not applicable here",
				},
				{
					id: "crawlers",
					name: "crawler policy",
					description: "AI crawlers may fetch content",
					status: "warning",
					score: 2,
					maxScore: 4,
					details: "two bots blocked",
				},
			],
		},
	],
};

const pick = (checks: AuditCheck[], name: string) => checks.find((c) => c.name === name);

describe("toAuditReport", () => {
	it("turns layers into sections and keeps score + rating", () => {
		const report = toAuditReport(SCAN, "https://acme.dev");
		expect(report.url).toBe("https://acme.dev");
		expect(report.score).toBe(82);
		expect(report.rating).toBe("Good");
		expect(report.sections.map((s) => s.name)).toEqual(["Agent Access"]);
	});

	it("counts pass/fail/skip with na+pending excluded and warning as a failure", () => {
		const [section] = toAuditReport(SCAN, "x").sections;
		expect(section.passed).toBe(1);
		expect(section.total).toBe(3); // mcp endpoint (na) is out of the denominator
		expect(section.skipped).toBe(1);
		expect(pick(section.checks, "crawler policy")?.passed).toBe(false);
		expect(pick(section.checks, "mcp endpoint")).toMatchObject({ passed: false, skipped: true });
	});

	it("keeps the raw status, estScoreGain, and summary", () => {
		const report = toAuditReport(SCAN, "x");
		expect(report.summary).toBe("acme.dev greets agents well but hides its spec.");
		const checks = report.sections[0].checks;
		expect(pick(checks, "agent gateway")?.status).toBe("pass");
		expect(pick(checks, "crawler policy")?.status).toBe("warning");
		expect(pick(checks, "markdown mirror")?.estScoreGain).toBe(1.8);
	});

	it("takes the fix from `recommendation`, never from `description`", () => {
		const checks = toAuditReport(SCAN, "x").sections[0].checks;
		const mirror = pick(checks, "markdown mirror");
		expect(mirror?.detail).toBe("0 of 12 pages mirrored");
		expect(mirror?.hint).toBe("Serve a .md variant of each documentation page");
		// passing and skipped checks never get a hint
		expect(pick(checks, "agent gateway")?.hint).toBeUndefined();
		expect(pick(checks, "mcp endpoint")?.hint).toBeUndefined();
	});

	it("derives tiers from each check's weight within its layer", () => {
		const checks = toAuditReport(SCAN, "x").sections[0].checks;
		expect(pick(checks, "agent gateway")?.tier).toBe("required"); // 10/10
		expect(pick(checks, "markdown mirror")?.tier).toBe("recommended"); // 6/10
		expect(pick(checks, "crawler policy")?.tier).toBe("recommended"); // 4/10
	});

	it("clamps scores into 0-100 and falls back to the requested URL", () => {
		expect(toAuditReport({ score: 140, layers: [] }, "x").score).toBe(100);
		expect(toAuditReport({ score: -5, layers: [] }, "x").score).toBe(0);
		expect(toAuditReport({ score: 50 }, "https://asked.example").url).toBe("https://asked.example");
		expect(toAuditReport({ score: 50, layers: [] }, "x").sections).toEqual([]);
	});
});

describe("ratingFor", () => {
	it("maps the score bands", () => {
		expect(ratingFor(100)).toBe("Excellent");
		expect(ratingFor(90)).toBe("Excellent");
		expect(ratingFor(89)).toBe("Good");
		expect(ratingFor(70)).toBe("Good");
		expect(ratingFor(69)).toBe("Fair");
		expect(ratingFor(50)).toBe("Fair");
		expect(ratingFor(49)).toBe("Needs Improvement");
		expect(ratingFor(0)).toBe("Needs Improvement");
	});
});

describe("sectionOf", () => {
	const entry = (name: string, passed: boolean, skipped = false): AuditCheck => ({
		name,
		passed,
		skipped: skipped || undefined,
		tier: "recommended",
	});

	it("excludes skipped checks from the totals but keeps them on the section", () => {
		const section = sectionOf("S", [entry("a", true), entry("b", false), entry("c", false, true)]);
		expect(section.passed).toBe(1);
		expect(section.total).toBe(2);
		expect(section.skipped).toBe(1);
		expect(section.checks).toHaveLength(3);
	});

	it("handles an all-skipped section", () => {
		const section = sectionOf("S", [entry("a", false, true), entry("b", false, true)]);
		expect(section.total).toBe(0);
		expect(section.skipped).toBe(2);
	});
});
