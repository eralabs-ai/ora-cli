import { describe, expect, it } from "vitest";
import { reportJson } from "./json";
import type { Report } from "./model";

const REPORT: Report = {
	url: "https://acme.dev",
	score: 75,
	rating: "Good",
	summary: "Mostly ready.",
	sections: [
		{
			name: "Agent Access",
			passed: 2,
			total: 3,
			skipped: 1,
			checks: [
				{ name: "agent gateway", passed: true, tier: "required", detail: "negotiated" },
				{ name: "crawler policy", passed: true, tier: "required" },
				{
					name: "markdown mirror",
					passed: false,
					tier: "recommended",
					detail: "missing",
					hint: "Serve .md twins",
					estScoreGain: 1.8,
					status: "fail",
				},
				{
					name: "mcp endpoint",
					passed: false,
					skipped: true,
					tier: "optional",
					detail: "not applicable",
					status: "na",
				},
			],
		},
	],
};

describe("reportJson", () => {
	it("emits the full result with snake_cased category keys", () => {
		const body = JSON.parse(reportJson(REPORT));
		expect(body.url).toBe("https://acme.dev");
		expect(body.score).toBe(75);
		expect(body.rating).toBe("Good");
		expect(body.summary).toBe("Mostly ready.");
		expect(Object.keys(body.categories)).toEqual(["agent_access"]);
		expect(body.categories.agent_access).toMatchObject({ passed: 2, total: 3, skipped: 1 });
	});

	it("includes every check — passed, failed, and skipped — regardless of view flags", () => {
		const body = JSON.parse(reportJson(REPORT));
		const checks = body.categories.agent_access.checks;
		expect(checks).toHaveLength(4);
		expect(checks[2]).toMatchObject({
			name: "markdown mirror",
			passed: false,
			skipped: false,
			hint: "Serve .md twins",
			estScoreGain: 1.8,
			status: "fail",
		});
		expect(checks[3]).toMatchObject({ name: "mcp endpoint", skipped: true });
		// absent optional fields are dropped, not nulled
		expect("hint" in checks[0]).toBe(false);
	});

	it("slugs multi-word and punctuated section names", () => {
		const twisted: Report = {
			...REPORT,
			sections: [{ ...REPORT.sections[0], name: "  Découverte & Reach!  " }],
		};
		const body = JSON.parse(reportJson(twisted));
		expect(Object.keys(body.categories)).toEqual(["d_couverte_reach"]);
	});
});
