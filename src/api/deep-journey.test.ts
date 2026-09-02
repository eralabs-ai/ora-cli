import { afterEach, describe, expect, it, vi } from "vitest";
import realDetail from "./__fixtures__/deep-journey-detail.json";
import {
	DeepJourneyApiError,
	fetchJourneyAgents,
	formatWait,
	performDeepJourney,
} from "./deep-journey";

// Fixture provenance: deep-journey-detail.json is a real projected
// GET /api/journey/runs/{id} response recorded from a dev run (contract
// 1.9.0). Variations below are explicit deltas on it, never hand-rolled.

const RUN_ID = (realDetail as { id: string }).id;

// The journey stream is named SSE, the same framing the platform client
// decodes (event: X + data: {json} + ": ping" heartbeats).
const journeyStream = (events: Array<[string, unknown]>): Response =>
	new Response(
		events
			.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
			.join(": ping\n\n"),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);

const asJson = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

const RECORD = {
	id: RUN_ID,
	status: "running",
	intent_id: "pricing",
	domain: "vercel.com",
	agent: { harness: "claude-agent-sdk", model: "claude-haiku-4-5" },
	started_at: "2026-08-14T00:00:00.000Z",
	stream_url: `/api/journey/runs/${RUN_ID}/stream`,
	contractVersion: "1.9.0",
};

function journeyMock(config: { trigger?: Response; stream?: Response; details?: unknown[] }) {
	let detailCalls = 0;
	return vi.fn(async (url: string | URL, init?: { method?: string }) => {
		const at = String(url);
		if (at.endsWith("/api/journey/runs") && init?.method === "POST") {
			return (
				config.trigger ??
				asJson(RECORD, 201, {
					"x-ratelimit-limit": "5",
					"x-ratelimit-remaining": "4",
					"x-ratelimit-reset": "1770000000",
				})
			);
		}
		if (at.includes("/stream") && config.stream) return config.stream;
		if (at.endsWith("/api/journey/agents")) {
			return asJson({
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
			});
		}
		if (at.includes("/api/journey/runs/")) {
			const details = config.details ?? [realDetail];
			const body = details[Math.min(detailCalls, details.length - 1)];
			detailCalls += 1;
			return asJson(body);
		}
		return asJson({});
	});
}

const OPTIONS = {
	intentId: "pricing",
	harness: "claude-agent-sdk",
	model: "claude-haiku-4-5",
	baseUrl: "https://journey.test",
};

describe("performDeepJourney", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("streams to the result and returns the terminal detail + allowance", async () => {
		vi.stubGlobal(
			"fetch",
			journeyMock({
				stream: journeyStream([
					["run_id", { run_id: RUN_ID }],
					[
						"trajectory",
						{ steps: [{ id: 0, type: "tool_call", action: "fetch", completed: false }] },
					],
					["processing", { message: "generating insights" }],
					["result", (realDetail as { result: unknown }).result],
				]),
			}),
		);

		const lines: string[] = [];
		const outcome = await performDeepJourney("vercel.com", {
			...OPTIONS,
			progress: (line) => lines.push(line),
		});

		expect(outcome.cached).toBe(false);
		expect(outcome.allowance).toEqual({ limit: 5, remaining: 4, resetAtMs: 1770000000000 });
		expect(outcome.detail.status).toBe("succeeded");
		expect(outcome.detail.step_count).toBe(19);
		expect(outcome.detail.verdict).toBe("unsatisfied");
		expect(lines.some((line) => line.includes("step 1"))).toBe(true);
	});

	it("hands each trajectory frame's cumulative steps to onTrajectory", async () => {
		vi.stubGlobal(
			"fetch",
			journeyMock({
				stream: journeyStream([
					["run_id", { run_id: RUN_ID }],
					["trajectory", { steps: [{ id: 0, type: "tool_call", action: "fetch" }] }],
					[
						"trajectory",
						{
							steps: [
								{ id: 0, type: "tool_call", action: "fetch" },
								{ id: 1, type: "tool_call", action: "search" },
							],
						},
					],
					["result", (realDetail as { result: unknown }).result],
				]),
			}),
		);

		const frames: number[] = [];
		await performDeepJourney("vercel.com", {
			...OPTIONS,
			onTrajectory: (steps) => frames.push(steps.length),
		});

		// One call per trajectory frame, each carrying the cumulative tree.
		expect(frames).toEqual([1, 2]);
	});

	it("treats a capped 200 as a cached outcome, not an error", async () => {
		vi.stubGlobal(
			"fetch",
			journeyMock({
				trigger: asJson(
					{
						...RECORD,
						status: "succeeded",
						rate_limited: true,
						limit: { max: 5, window_ms: 86_400_000 },
						retry_after_ms: 3_600_000,
					},
					200,
					{ "x-ratelimit-limit": "5", "x-ratelimit-remaining": "0" },
				),
			}),
		);

		const outcome = await performDeepJourney("vercel.com", OPTIONS);
		expect(outcome.cached).toBe(true);
		expect(outcome.retryAfterMs).toBe(3_600_000);
		expect(outcome.detail.status).toBe("succeeded");
	});

	it("resolves a stream error frame as the failed detail (exit-code parity with --no-stream)", async () => {
		vi.stubGlobal(
			"fetch",
			journeyMock({
				stream: journeyStream([
					["run_id", { run_id: RUN_ID }],
					["error", { message: "engine stream interrupted" }],
				]),
				details: [{ ...(realDetail as object), status: "failed", result: undefined }],
			}),
		);

		const outcome = await performDeepJourney("vercel.com", OPTIONS);
		expect(outcome.detail.status).toBe("failed");
		expect(outcome.engineError).toBe("engine stream interrupted");
	});

	it("maps a durable 429 to an actionable error with the retry hint", async () => {
		vi.stubGlobal(
			"fetch",
			journeyMock({
				trigger: asJson({ error: "Too many requests", retry_after_ms: 86_400_000 }, 429, {
					"retry-after": "86400",
				}),
			}),
		);

		await expect(performDeepJourney("vercel.com", OPTIONS)).rejects.toThrow(DeepJourneyApiError);
	});

	it("refuses to treat a never-settling run as terminal (truncated stream)", async () => {
		// The stream closes cleanly with no result/error frame (e.g. the serving
		// function's 800s ceiling) and the detail never leaves "running".
		vi.useFakeTimers();
		try {
			vi.stubGlobal(
				"fetch",
				journeyMock({
					stream: journeyStream([
						["run_id", { run_id: RUN_ID }],
						["trajectory", { steps: [{ id: 0, type: "tool_call", action: "fetch" }] }],
					]),
					details: [{ ...(realDetail as object), status: "running", result: undefined }],
				}),
			);

			// Capture the settled state up front - the rejection lands only after
			// the fake clock advances past the detail-settle retries.
			const settled = performDeepJourney("vercel.com", OPTIONS).then(
				() => "resolved",
				(cause) => cause,
			);
			await vi.advanceTimersByTimeAsync(10_000);
			const error = await settled;
			expect(error).toBeInstanceOf(DeepJourneyApiError);
			expect(String(error)).toMatch(/still executing/);
		} finally {
			vi.useRealTimers();
		}
	});

	it("polls to the terminal detail with --no-stream", async () => {
		vi.stubGlobal(
			"fetch",
			journeyMock({
				details: [{ ...(realDetail as object), status: "running", result: undefined }, realDetail],
			}),
		);

		const outcome = await performDeepJourney("vercel.com", {
			...OPTIONS,
			noStream: true,
			pollEveryMs: 1,
		});
		expect(outcome.detail.status).toBe("succeeded");
		expect(outcome.detail.result).toBeDefined();
	});
});

describe("performDeepJourney - keyed tier", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	const succeededMock = () =>
		journeyMock({
			trigger: asJson({ ...RECORD, status: "succeeded" }, 201, {
				"x-ratelimit-limit": "1000",
				"x-ratelimit-remaining": "999",
			}),
		});

	const triggerInit = (mock: ReturnType<typeof vi.fn>) => {
		const call = mock.mock.calls.find(
			([url, init]) =>
				String(url).endsWith("/api/journey/runs") &&
				(init as { method?: string } | undefined)?.method === "POST",
		);
		return call?.[1] as { headers: Record<string, string>; body: string };
	};

	it("sends the partner key as a bearer token on the trigger POST", async () => {
		const mock = succeededMock();
		vi.stubGlobal("fetch", mock);

		await performDeepJourney("vercel.com", { ...OPTIONS, apiKey: "pk_live_demo_0123456789" });
		expect(triggerInit(mock).headers.authorization).toBe("Bearer pk_live_demo_0123456789");
	});

	it("sends no authorization header without a key", async () => {
		// Blank out any ambient keys so this asserts the true keyless path.
		vi.stubEnv("ORA_PARTNER_API_KEY", "");
		vi.stubEnv("ORA_SCAN_API_KEY", "");
		const mock = succeededMock();
		vi.stubGlobal("fetch", mock);

		await performDeepJourney("vercel.com", OPTIONS);
		expect(triggerInit(mock).headers.authorization).toBeUndefined();
	});

	it("reads the key from ORA_PARTNER_API_KEY when no explicit option is given", async () => {
		vi.stubEnv("ORA_PARTNER_API_KEY", "pk_live_from_env_0123456789");
		const mock = succeededMock();
		vi.stubGlobal("fetch", mock);

		await performDeepJourney("vercel.com", OPTIONS);
		expect(triggerInit(mock).headers.authorization).toBe("Bearer pk_live_from_env_0123456789");
	});

	it("runs a free-text task through the custom intent arm", async () => {
		const mock = succeededMock();
		vi.stubGlobal("fetch", mock);

		await performDeepJourney("vercel.com", {
			...OPTIONS,
			intentId: undefined,
			task: "Find how to export a project to GitHub",
			apiKey: "pk_live_demo_0123456789",
		});

		const body = JSON.parse(triggerInit(mock).body) as { intent: Record<string, unknown> };
		expect(body.intent).toEqual({
			custom: "Find how to export a project to GitHub",
			domain: "vercel.com",
		});
	});

	it("maps the custom-intent 401 to an actionable partner-key error", async () => {
		vi.stubGlobal(
			"fetch",
			journeyMock({
				trigger: asJson(
					{ error: "Custom intents require a partner API key", code: "CUSTOM_INTENT_REQUIRES_KEY" },
					401,
				),
			}),
		);

		await expect(
			performDeepJourney("vercel.com", { ...OPTIONS, intentId: undefined, task: "Find the docs" }),
		).rejects.toThrow(/ORA_PARTNER_API_KEY|--api-key/);
	});

	it("falls back to polling when the stream goes quiet instead of abandoning the run", async () => {
		// The stream opens but never emits a frame (yesterday's production failure
		// mode); the run itself keeps executing server-side. The client must
		// switch to polling the detail rather than throwing away a paid run.
		const hangingStream = (signal: AbortSignal | undefined): Response =>
			new Response(
				new ReadableStream({
					start(controller) {
						signal?.addEventListener("abort", () =>
							controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })),
						);
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);

		const inner = journeyMock({
			details: [{ ...(realDetail as object), status: "running", result: undefined }, realDetail],
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL, init?: { method?: string; signal?: AbortSignal }) => {
				if (String(url).includes("/stream")) return hangingStream(init?.signal);
				return inner(url, init);
			}),
		);

		const lines: string[] = [];
		const outcome = await performDeepJourney("vercel.com", {
			...OPTIONS,
			idleMs: 50,
			pollEveryMs: 1,
			progress: (line) => lines.push(line),
		});

		expect(outcome.detail.status).toBe("succeeded");
		expect(lines.some((line) => /polling/.test(line))).toBe(true);
	});
});

describe("fetchJourneyAgents", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("returns the public roster", async () => {
		vi.stubGlobal("fetch", journeyMock({}));
		const { agents, defaultId } = await fetchJourneyAgents("https://journey.test");
		expect(defaultId).toBe("cas-haiku");
		expect(agents[0]?.harness).toBe("claude-agent-sdk");
	});
});

describe("formatWait", () => {
	it("rounds up to the readable unit", () => {
		expect(formatWait(86_400_000)).toBe("24h");
		expect(formatWait(90_000)).toBe("2m");
		expect(formatWait(4_000)).toBe("4s");
		expect(formatWait(0)).toBe("soon");
	});
});
