import pc from "picocolors";
import {
	DeepJourneyApiError,
	type DeepJourneyOutcome,
	fetchJourneyAgents,
	fetchJourneyIntents,
	formatWait,
	type JourneyAgentOption,
	performDeepJourney,
} from "../api/deep-journey";
import { spinner } from "../ui/spinner";

// `ax deep-journey <url>`: run a real agent at a site through ora's PUBLIC
// journey API (no key, no workspace - unlike `ax journey`, which drives the
// authenticated platform). Thin client: verdict, step_count, and insight are
// rendered exactly as the contract delivers them; nothing is re-judged here.

export const EXIT = { OK: 0, RUN_FAILED: 1, USAGE: 2, API: 3 } as const;

// The documented caps, shown up front so a CI author can budget runs before
// spending one. The live remaining allowance comes from the response headers
// after the trigger. One line per tier - which one the caller is on is known
// locally (key present or not).
const CAPS_LINE = "public caps: 100 runs/24h per target · 200 runs/24h per IP";
const KEYED_CAPS_LINE = "keyed caps: 1000 runs/24h per key · no per-target cap";

export interface DeepJourneyCommandInput {
	url: string;
	intent?: string;
	/** Free-text task (keyed tier); mutually exclusive with `intent`. */
	task?: string;
	/** Partner API key (--api-key); falls back to $ORA_PARTNER_API_KEY, then $ORA_SCAN_API_KEY. */
	apiKey?: string;
	agent?: string;
	json: boolean;
	noStream: boolean;
}

function fail(message: string): typeof EXIT.API {
	console.error(pc.red(`ax deep-journey: ${message}`));
	return EXIT.API;
}

function verdictLine(verdict: string | undefined, status: string): string {
	if (status === "failed") return pc.red("✗ run failed");
	switch (verdict) {
		case "satisfied":
			return pc.green("✓ task satisfied");
		case "partial":
			return pc.yellow("◐ partially satisfied");
		case "unsatisfied":
			return pc.red("✗ task not satisfied");
		default:
			return pc.dim("· not gradable");
	}
}

function agentLine(agent: JourneyAgentOption): string {
	return `${agent.label} · ${agent.variant}`;
}

function renderOutcome(outcome: DeepJourneyOutcome, url: string): string[] {
	const { detail } = outcome;
	const lines: string[] = [""];

	lines.push(`${verdictLine(detail.verdict, detail.status)}  ${pc.dim(detail.domain ?? url)}`);

	const chips: string[] = [];
	if (detail.step_count != null) chips.push(`${detail.step_count} steps`);
	const result = detail.result;
	if (result?.num_turns != null) chips.push(`${result.num_turns} turns`);
	if (result?.duration_ms != null) chips.push(`${(result.duration_ms / 1000).toFixed(1)}s`);
	if (chips.length) lines.push(pc.dim(chips.join(" · ")));

	if (result?.insight?.summary) {
		lines.push("", result.insight.summary);
	}
	for (const observation of result?.insight?.key_observations ?? []) {
		lines.push(pc.dim(`  - ${observation}`));
	}

	if (detail.status === "failed") {
		lines.push(
			"",
			pc.dim(
				outcome.engineError
					? `Engine error: ${outcome.engineError} — re-running is free to try.`
					: "The run ended in an engine error; re-running is free to try.",
			),
		);
	}

	lines.push("", pc.dim(`For the 4-layer readiness audit, run: ax audit ${url}`));
	return lines;
}

export async function deepJourneyCommand(input: DeepJourneyCommandInput): Promise<number> {
	const target = input.url.trim();
	if (!target) {
		console.error("ax deep-journey: a target URL or domain is required");
		return EXIT.USAGE;
	}

	const interactive = !input.json && process.stderr.isTTY;

	// Tier resolution, before any network call: the two intent arms are
	// mutually exclusive, and a free-text task without a key would only 401
	// server-side - fail fast with the fix instead of spending a request.
	const task = input.task?.trim() || undefined;
	const apiKey =
		input.apiKey || process.env.ORA_PARTNER_API_KEY || process.env.ORA_SCAN_API_KEY || undefined;
	if (task && input.intent !== undefined) {
		console.error(
			"ax deep-journey: --task and --intent are mutually exclusive — a free-text task replaces the curated intent",
		);
		return EXIT.USAGE;
	}
	if (task && !apiKey) {
		console.error(
			"ax deep-journey: --task needs an ora partner API key — set ORA_PARTNER_API_KEY or pass --api-key (keys are issued by ora on request)",
		);
		return EXIT.USAGE;
	}

	// Resolve the intent and agent against the live rosters (both static,
	// cached routes) so a typo fails with the menu instead of a bare 400. A
	// free-text task skips the intent roster entirely - the server takes the
	// text as-is (anchored to the target) instead of a template id.
	let intentId = input.intent;
	let agent: JourneyAgentOption;
	try {
		const [intents, agents] = await Promise.all([
			task ? undefined : fetchJourneyIntents(),
			fetchJourneyAgents(),
		]);
		if (intents) {
			if (intentId === undefined) {
				intentId = intents.defaultId;
			} else if (!intents.intents.some((option) => option.id === intentId)) {
				console.error(
					`ax deep-journey: unknown intent "${intentId}". Available intents:\n${intents.intents
						.map((option) => `  ${option.id.padEnd(12)} ${option.hint}`)
						.join("\n")}`,
				);
				return EXIT.USAGE;
			}
		}
		const wantedAgent = input.agent ?? agents.defaultId;
		const found = agents.agents.find((option) => option.id === wantedAgent);
		if (!found) {
			console.error(
				`ax deep-journey: unknown agent "${wantedAgent}". Available agents:\n${agents.agents
					.map((option) => `  ${option.id.padEnd(12)} ${agentLine(option)}`)
					.join("\n")}`,
			);
			return EXIT.USAGE;
		}
		agent = found;
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}

	if (!input.json) {
		console.error(pc.dim(apiKey ? KEYED_CAPS_LINE : CAPS_LINE));
	}
	if (interactive) {
		spinner.start(`Sending ${agentLine(agent)} to ${target} (${task ? `"${task}"` : intentId})`);
	}

	let outcome: DeepJourneyOutcome;
	try {
		outcome = await performDeepJourney(target, {
			intentId: task ? undefined : intentId,
			task,
			apiKey,
			harness: agent.harness,
			model: agent.model,
			noStream: input.noStream,
			progress: interactive ? (line) => spinner.update(line) : undefined,
		});
	} catch (error) {
		if (interactive) spinner.stop();
		if (error instanceof DeepJourneyApiError) return fail(error.message);
		return fail(error instanceof Error ? error.message : String(error));
	}
	if (interactive) spinner.stop();

	if (input.json) {
		console.log(JSON.stringify(outcome.detail, null, 2));
		return outcome.detail.status === "failed" ? EXIT.RUN_FAILED : EXIT.OK;
	}

	if (outcome.cached) {
		console.error(
			pc.yellow(
				`This target hit its 24h cap — showing the most recent stored run${
					outcome.retryAfterMs ? ` (fresh run in ${formatWait(outcome.retryAfterMs)})` : ""
				}.`,
			),
		);
	} else if (outcome.allowance.remaining !== undefined && outcome.allowance.limit !== undefined) {
		console.error(
			pc.dim(
				`allowance: ${outcome.allowance.remaining} of ${outcome.allowance.limit} target runs left in the 24h window`,
			),
		);
	}

	for (const line of renderOutcome(outcome, target)) console.log(line);
	return outcome.detail.status === "failed" ? EXIT.RUN_FAILED : EXIT.OK;
}
