import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderWebmcpReport } from "./report";
import type { PublicWebmcpAudit } from "./vendor/projection";

const AUDIT = (
	JSON.parse(
		readFileSync(new URL("./__fixtures__/ora-ai-audit.json", import.meta.url), "utf8"),
	) as { audit: PublicWebmcpAudit }
).audit;

/** Rendered lines as one whitespace-collapsed string, for asserting on prose
 * that the renderer wraps to the terminal width. */
const flat = (lines: string[]) => lines.join(" ").replace(/\s+/g, " ");

describe("renderWebmcpReport", () => {
	it("keeps a withheld grade beside a real score, and says why", () => {
		// The fixture's own state: coverage 49 sits under the threshold, so ora
		// reports the score and withholds the letter. Rendering that as a blank,
		// or as an error, would misreport a normal outcome.
		const out = flat(renderWebmcpReport(AUDIT));
		expect(out).toContain("77/100");
		expect(out).toContain("grade withheld");
		expect(out).toMatch(/only 49% of the applicable check weight/);
	});

	it("leads with the availability gate and renders its reasons verbatim", () => {
		// Availability decides whether a score exists at all, and its `detail` is
		// where the server puts the note about a native-API claim that came from
		// the developer's own browser. Paraphrasing it would drop that.
		const out = flat(renderWebmcpReport(AUDIT));
		expect(out).toContain("agent-ready");
		expect(out).toContain(AUDIT.availability.reasons[0].detail.slice(0, 60));
	});

	it("shows no score at all for a page the gate turned away", () => {
		// `not-ready` carries score and grade null. An empty scorecard beside the
		// reasons would bury the part the developer has to act on.
		const blocked = {
			...AUDIT,
			score: null,
			grade: null,
			availability: {
				status: "not-ready" as const,
				reasons: [{ id: "no-tools" as const, detail: "This page registers no tools." }],
			},
		};
		const out = flat(renderWebmcpReport(blocked));
		expect(out).toContain("not agent-ready");
		expect(out).toContain("This page registers no tools.");
		expect(out).not.toContain("/100");
		expect(out).not.toContain("Pillars");
	});

	it("marks a pillar that reads 0 because nothing in it was measured", () => {
		// task-completion is 0 in this fixture only because tool-selection went
		// unmeasured. That is not a measured zero, and the payload cannot tell
		// the two apart - so this reads the findings instead of the number.
		const out = flat(renderWebmcpReport(AUDIT));
		expect(out).toMatch(/Task completion .*nothing measured/);
		expect(out).toMatch(/Trust .*weight 20/);
		expect(out).not.toMatch(/Trust .*nothing measured/);
	});

	it("names the four pillars, not the retired categories", () => {
		const out = flat(renderWebmcpReport(AUDIT));
		for (const pillar of ["Shared experience", "Task completion", "Tool quality", "Trust"]) {
			expect(out).toContain(pillar);
		}
		expect(out).not.toMatch(/WebMCP use|Usefulness|Human experience/);
	});

	it("shows na and unmeasured as different things", () => {
		// The server draws this line deliberately: `na` is not charged, while
		// `unmeasured` counts against coverage. One "skipped" bucket would erase it.
		const out = renderWebmcpReport(AUDIT).join("\n");
		expect(out).toContain("Not measured");
		expect(out).toContain("Not applicable");
	});

	it("never claims a local audit was published or ranked", () => {
		// Collapsed, because the footer is wrapped prose: asserting on the raw
		// join would break the moment a phrase straddles a line.
		const out = flat(renderWebmcpReport(AUDIT));
		expect(out).toMatch(/not published or ranked anywhere/);
		expect(out).toMatch(/scored without being stored/);
		// It says where the capture came from, not where the page lives - this
		// command audits public URLs too.
		expect(out).not.toMatch(/ran against your machine/);
	});

	it("hides passing checks until asked, then lists them", () => {
		expect(renderWebmcpReport(AUDIT).join("\n")).toMatch(/7 passing \(--show-passing to list\)/);
		const shown = renderWebmcpReport(AUDIT, { showPassing: true }).join("\n");
		expect(shown).toContain("Passing (7)");
	});

	it("strips terminal control characters out of page-authored text", () => {
		// Verified against a real capture: a page can register a tool whose name and
		// description carry ANSI sequences, and they survive the shim intact. An
		// erase-display sequence reaching the terminal would blank the report the
		// reader is looking at.
		const hostile = {
			...AUDIT,
			findings: [
				{
					...AUDIT.findings[0],
					// `fail` so it is rendered: passing checks are hidden by default,
					// and a hidden finding would make this assert nothing.
					status: "fail" as const,
					toolName: "search\u001b[31m",
					details: "line one\u001b[2Jcleared",
					evidence: "evidence\u001b[1m",
				},
			],
		};
		const out = renderWebmcpReport(hostile).join("\n");
		expect(out).not.toContain("\u001b[2J");
		expect(out).not.toContain("\u001b[31m");
		// The words themselves are still there - this strips control bytes, it does
		// not rewrite what the server said.
		expect(out).toContain("cleared");
		expect(out).toContain("search");
	});
});
