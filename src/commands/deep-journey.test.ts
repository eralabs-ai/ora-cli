import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deepJourneyCommand, EXIT } from "./deep-journey";

// Command-layer contract for the keyed tier: flag exclusivity and the
// fail-fast key check happen HERE, before any network call - the API client
// stays a thin sender. The API layer itself is covered in
// src/api/deep-journey.test.ts; everything below mocks it out.

vi.mock("../api/deep-journey", async (importOriginal) => {
	const real = await importOriginal<typeof import("../api/deep-journey")>();
	return {
		...real,
		fetchJourneyIntents: vi.fn(async () => ({
			intents: [{ id: "pricing", label: "Pricing", hint: "find pricing", template: "" }],
			defaultId: "pricing",
		})),
		fetchJourneyAgents: vi.fn(async () => ({
			agents: [
				{
					id: "cas-haiku",
					label: "Claude Code",
					variant: "Haiku 4.5",
					harness: "claude-agent-sdk",
					model: "claude-haiku-4-5",
				},
			],
			defaultId: "cas-haiku",
		})),
		performDeepJourney: vi.fn(async () => ({
			record: { id: "run_1", status: "succeeded" },
			cached: false,
			allowance: {},
			detail: { id: "run_1", status: "succeeded", domain: "zapier.com", contractVersion: "1.15.0" },
		})),
	};
});

import { fetchJourneyIntents, performDeepJourney } from "../api/deep-journey";

const BASE = { url: "zapier.com", json: true, noStream: false };

describe("deepJourneyCommand - keyed tier flags", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("ORA_PARTNER_API_KEY", "");
		vi.stubEnv("ORA_SCAN_API_KEY", "");
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("rejects --task combined with --intent as a usage error", async () => {
		const code = await deepJourneyCommand({
			...BASE,
			task: "Find the pricing page",
			intent: "pricing",
			apiKey: "pk_live_demo_0123456789",
		});
		expect(code).toBe(EXIT.USAGE);
		expect(performDeepJourney).not.toHaveBeenCalled();
	});

	it("fails fast on --task without any partner key", async () => {
		const code = await deepJourneyCommand({ ...BASE, task: "Find the pricing page" });
		expect(code).toBe(EXIT.USAGE);
		expect(performDeepJourney).not.toHaveBeenCalled();
	});

	it("runs a --task journey without resolving curated intents", async () => {
		const code = await deepJourneyCommand({
			...BASE,
			task: "Find how to build a Slack to Sheets zap",
			apiKey: "pk_live_demo_0123456789",
		});
		expect(code).toBe(EXIT.OK);
		expect(fetchJourneyIntents).not.toHaveBeenCalled();
		expect(performDeepJourney).toHaveBeenCalledWith(
			"zapier.com",
			expect.objectContaining({
				task: "Find how to build a Slack to Sheets zap",
				intentId: undefined,
				apiKey: "pk_live_demo_0123456789",
			}),
		);
	});

	it("accepts a key from ORA_PARTNER_API_KEY for --task runs", async () => {
		vi.stubEnv("ORA_PARTNER_API_KEY", "pk_live_from_env_0123456789");
		const code = await deepJourneyCommand({ ...BASE, task: "Find the pricing page" });
		expect(code).toBe(EXIT.OK);
		expect(performDeepJourney).toHaveBeenCalled();
	});

	it("draws the attribution graph from the terminal trajectory (non-json)", async () => {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
			logs.push(String(line ?? ""));
		});
		vi.mocked(performDeepJourney).mockResolvedValueOnce({
			// biome-ignore lint/suspicious/noExplicitAny: partial record is enough for this render path
			record: { id: "run_1", status: "succeeded" } as any,
			cached: false,
			allowance: {},
			detail: {
				id: "run_1",
				status: "succeeded",
				domain: "zapier.com",
				contractVersion: "1.15.0",
				result: {
					outcome: "completed",
					verdict: "satisfied",
					trajectory: {
						steps: [
							{ id: 0, type: "text", text: "Let me start at the homepage." },
							{
								id: 1,
								type: "tool_call",
								action: "fetch",
								tool: "WebFetch",
								url_host: "zapier.com",
								url_path: "/pricing",
								status: 200,
								attribution: { kind: "prior_knowledge" },
							},
						],
					},
					// biome-ignore lint/suspicious/noExplicitAny: partial detail is enough for this render path
				} as any,
				// biome-ignore lint/suspicious/noExplicitAny: partial detail is enough for this render path
			} as any,
		});

		const code = await deepJourneyCommand({
			url: "zapier.com",
			json: false,
			noStream: true,
			intent: "pricing",
		});

		expect(code).toBe(EXIT.OK);
		const out = logs.join("\n");
		// The graph tally, a fetch box for the visited path, and the reasoning note.
		expect(out).toContain("steps");
		expect(out).toContain("zapier.com/pricing");
		expect(out).toContain("Let me start at the homepage");
	});

	it("surfaces run_signals metrics and token/cost in the finale", async () => {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
			logs.push(String(line ?? ""));
		});
		vi.mocked(performDeepJourney).mockResolvedValueOnce({
			// biome-ignore lint/suspicious/noExplicitAny: partial record is enough for this render path
			record: { id: "run_1", status: "succeeded" } as any,
			cached: false,
			allowance: {},
			detail: {
				id: "run_1",
				status: "succeeded",
				domain: "zapier.com",
				step_count: 12,
				verdict: "satisfied",
				contractVersion: "1.23.0",
				result: {
					outcome: "success",
					verdict: "satisfied",
					num_turns: 9,
					duration_ms: 48300,
					cost_usd: 0.0423,
					input_tokens: 11840,
					output_tokens: 2960,
					run_signals: {
						version: 3,
						intent_category: "signup",
						category_confidence: "high",
						outcome: "success",
						reached_anchor: true,
						steps_count: 12,
						search_count: 3,
						link_following_rate: 0.5,
						prior_knowledge_ratio: 0.3,
						signals_observed: [],
						journey_layers: ["discovery", "identity", "access"],
					},
					// Four fetches: 3 OK + 1 404 (reliability 75%); origins: 2 followed
					// links, 1 web search, 1 prior knowledge over 4 → on-site 75%.
					trajectory: {
						steps: [
							{
								id: 0,
								type: "tool_call",
								action: "fetch",
								status: 200,
								attribution: { kind: "prior_knowledge" },
							},
							{
								id: 1,
								type: "tool_call",
								action: "fetch",
								status: 200,
								attribution: { kind: "previous_artifact" },
							},
							{ id: 2, type: "tool_call", action: "search", search_query: "q" },
							{
								id: 3,
								type: "tool_call",
								action: "fetch",
								status: 404,
								attribution: { kind: "web_search" },
							},
							{
								id: 4,
								type: "tool_call",
								action: "fetch",
								status: 200,
								attribution: { kind: "previous_artifact" },
							},
						],
					},
					insight: { summary: "Reached checkout via the pricing page.", key_observations: [] },
					// biome-ignore lint/suspicious/noExplicitAny: partial detail is enough for this render path
				} as any,
				// biome-ignore lint/suspicious/noExplicitAny: partial detail is enough for this render path
			} as any,
		});

		const code = await deepJourneyCommand({
			url: "zapier.com",
			json: false,
			noStream: true,
			intent: "pricing", // the only intent the module mock's roster offers
		});

		expect(code).toBe(EXIT.OK);
		const out = logs.join("\n");
		// Chip row: token total (input+output) and cost.
		expect(out).toContain("14.8k tokens");
		expect(out).toContain("$0.042");
		expect(out).toContain("3 searches");
		// The three canonical journey metrics, computed from the trajectory.
		expect(out).toContain("on-site discovery");
		expect(out).toContain("reliability");
		expect(out).toContain("link following");
		expect(out).toContain("75%"); // on-site (3/4 non-web-search) and reliability (3/4 OK)
		expect(out).toContain("50%"); // link following = run_signals.link_following_rate
		// Reach + layers context from run_signals.
		expect(out).toContain("reached the site");
		expect(out).toContain("discovery");
		expect(out).toContain("access");
		// The intent-category line and the turns chip are intentionally not shown.
		expect(out).not.toContain("turns");
		expect(out).not.toContain("intent signup");
	});
});
