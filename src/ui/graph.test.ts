import { beforeAll, describe, expect, it } from "vitest";
import type { JourneyStep } from "../api/platform";
import { buildJourneyTree, drawJourneyTree, journeySummary, splitUrl } from "./graph";

const GOAL = "Locate the REST API reference and confirm the auth flow";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes must go before asserting
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

beforeAll(() => {
	// Freeze a wide virtual terminal so truncation never affects assertions.
	Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
});

// Shape mirrors a live capture: think → search → fetch that 301s (prior
// knowledge) → think → fetch discovered on step 3 → fetch discovered on step 5
// → one thought after the last action. `attribution.referrer.step_id` carries
// ora's explicit parent edge for the two link-follows.
const TRAJECTORY: JourneyStep[] = [
	{
		id: 0,
		turn: 1,
		type: "text",
		kind: "reasoning",
		thinking: "Search for the official reference.",
	},
	{ id: 1, turn: 2, type: "text", kind: "text", text: "On it." },
	{
		id: 2,
		turn: 3,
		type: "tool_call",
		tool: "WebSearch",
		action: "search",
		input_display: "acme REST API reference",
		duration_ms: 3100,
		attribution: { kind: "web_search", method: "heuristic" },
		output_structured: { links: [{ url: "https://docs.acme.dev/reference" }] },
	},
	{
		id: 3,
		turn: 4,
		type: "tool_call",
		tool: "WebFetch",
		action: "fetch",
		input_display: "GET https://acme.dev/api",
		status: 301,
		duration_ms: 240,
		attribution: { kind: "prior_knowledge", method: "heuristic" },
	},
	{ id: 4, turn: 5, type: "text", kind: "reasoning", thinking: "Moved — chase the redirect." },
	{
		id: 5,
		turn: 6,
		type: "tool_call",
		tool: "WebFetch",
		action: "fetch",
		input_display: "GET https://docs.acme.dev/reference",
		duration_ms: 410,
		attribution: { kind: "previous_artifact", referrer: { step_id: 3, turn: 4 } },
	},
	{
		id: 7,
		turn: 8,
		type: "tool_call",
		tool: "WebFetch",
		action: "fetch",
		input_display: "GET https://docs.acme.dev/reference/auth",
		duration_ms: 180,
		attribution: { kind: "previous_artifact", referrer: { step_id: 5, turn: 6 } },
	},
	{ id: 8, turn: 9, type: "text", kind: "reasoning", thinking: "Both pages confirmed." },
];

describe("splitUrl", () => {
	it("separates host and path from display text", () => {
		expect(splitUrl("GET https://docs.acme.dev/reference/auth")).toEqual({
			host: "docs.acme.dev",
			path: "/reference/auth",
		});
	});

	it("defaults the path and tolerates non-URLs", () => {
		expect(splitUrl("https://acme.dev")).toEqual({ host: "acme.dev", path: "/" });
		expect(splitUrl("just words")).toEqual({});
		expect(splitUrl(undefined)).toEqual({});
	});
});

describe("buildJourneyTree", () => {
	it("roots everything at the intent — no synthetic homepage box", () => {
		const { root } = buildJourneyTree(TRAJECTORY, GOAL, true);
		expect(root.kind).toBe("intent");
		expect(root.icon).toBe("◆");
		expect(root.label).toBe(GOAL);
		expect(root.children.map((c) => c.kind)).toEqual(["search", "fetch"]);
	});

	it("nests link-follows under their referrer step", () => {
		const { root } = buildJourneyTree(TRAJECTORY, GOAL, true);
		const entry = root.children[1]; // acme.dev/api — the 301
		expect(entry.label).toContain("acme.dev/api");
		expect(entry.tone).toBe("redirect");
		expect(entry.meta).toBe("↳ 301");
		expect(entry.children).toHaveLength(1);
		expect(entry.children[0].label).toContain("docs.acme.dev/reference");
		expect(entry.children[0].children[0].label).toContain("/reference/auth");
	});

	it("pins reasoning to the following action and keeps the tail loose", () => {
		const { root, looseNotes } = buildJourneyTree(TRAJECTORY, GOAL, true);
		expect(root.children[0].notes).toEqual(["Search for the official reference."]);
		expect(root.children[1].children[0].notes).toEqual(["Moved — chase the redirect."]);
		expect(looseNotes).toEqual(["Both pages confirmed."]);
	});

	it("highlights the newest box only while the agent is still working", () => {
		const live = buildJourneyTree(TRAJECTORY, GOAL, false);
		const tip = live.root.children[1].children[0].children[0];
		expect(tip.tone).toBe("active");
		expect(tip.meta).toBe("…");

		const done = buildJourneyTree(TRAJECTORY, GOAL, true);
		expect(done.root.children[1].children[0].children[0].tone).toBe("ok");
	});
});

describe("journeySummary", () => {
	it("tallies steps, reasoning, and searches", () => {
		const text = plain(journeySummary(TRAJECTORY));
		expect(text).toContain("8 steps");
		expect(text).toContain("3 reasoning");
		expect(text).toContain("1 search");
	});
});

describe("drawJourneyTree", () => {
	it("draws boxes, trunks, elbows, and reasoning markers", () => {
		const picture = plain(drawJourneyTree(buildJourneyTree(TRAJECTORY, GOAL, true)).join("\n"));

		expect(picture).toContain(`◆ ${GOAL}`);
		expect(picture).toContain('🔍 "acme REST API reference"');
		expect(picture).toContain("↳ 301");
		expect(picture).toContain("docs.acme.dev/reference/auth");
		// trunk out of a parent, elbows into children
		expect(picture).toContain("╰─┬");
		expect(picture).toContain("├──┤");
		expect(picture).toContain("╰──┤");
		// reasoning markers ride the edge above their action; the tail floats below
		expect(picture).toContain("│  (…) Search for the official reference.");
		expect(picture).toContain("(…) Moved — chase the redirect.");
		expect(picture).toContain("(…) Both pages confirmed.");
	});

	it("keeps every box's three border lines column-aligned", () => {
		const rows = drawJourneyTree(buildJourneyTree(TRAJECTORY, GOAL, true)).map(plain);
		for (let i = 0; i < rows.length; i++) {
			const opensAt = rows[i].indexOf("╭");
			if (opensAt === -1) continue;
			const bottom = rows[i + 2];
			expect(bottom.indexOf("╰")).toBe(opensAt);
			expect(bottom.indexOf("╯")).toBe(rows[i].indexOf("╮"));
		}
	});
});
