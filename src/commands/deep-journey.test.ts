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
});
