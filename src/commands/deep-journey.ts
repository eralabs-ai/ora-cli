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
import type { JourneyStep } from "../api/platform";
import type { JourneyRunResult, JourneyTrajectoryStep } from "../contract";
import { flow, plain, stdoutWidth } from "../ui/ansi";
import { buildJourneyTree, drawJourneyTree, journeySummary } from "../ui/graph";
import { LivePanel } from "../ui/panel";
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

// The live graph (ui/graph) is written against the platform `JourneyStep`
// shape; the public journey stream speaks the contract `JourneyTrajectoryStep`.
// This bridges the two so `deep-journey` draws the very same attribution tree
// `ax journey` does. Two field-name gaps to close:
//   · the graph reads `input_display` for the box label — searches carry it in
//     `search_query`, fetches in `url_host`/`url_path` (which we re-assemble
//     into a scheme-qualified URL so the graph's splitUrl can parse it).
//   · the tree edge lives in `attribution.referrer.step_id` for the graph;
//     the contract also exposes it as the top-level `parent_id`, so fall back.
function toGraphStep(step: JourneyTrajectoryStep): JourneyStep {
	const isSearch = step.action === "search";
	const inputDisplay = isSearch
		? step.search_query
		: step.url_host || step.url_path
			? `https://${step.url_host ?? ""}${step.url_path ?? ""}`
			: step.url;
	return {
		id: step.id,
		turn: step.turn ?? 0,
		type: step.type,
		// Contract text steps are the agent's narrative reasoning between actions;
		// tag them so the graph attaches them as (…) notes above the next box.
		kind: step.type === "text" ? "reasoning" : undefined,
		text: step.text,
		thinking: step.text,
		tool: step.tool,
		action: step.action,
		input_display: inputDisplay,
		status: step.status,
		duration_ms: step.duration_ms,
		attribution: step.attribution
			? {
					kind: step.attribution.kind,
					referrer: { step_id: step.attribution.referrer?.step_id ?? step.parent_id },
				}
			: undefined,
	};
}

// The attribution tree plus its one-line tally, indented to match the report.
// `settled` false paints the newest box as the live/active node.
function graphLines(steps: JourneyStep[], intent: string, settled: boolean): string[] {
	return [
		`  ${journeySummary(steps)}`,
		"",
		...drawJourneyTree(buildJourneyTree(steps, intent, settled)).map((row) => `  ${row}`),
	];
}

// --- Finale ---

const chipTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function chipCost(usd: number): string {
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	if (usd < 1) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(2)}`;
}

/** input + output; the meaningful "how big was this run" figure (cache is separate). */
function totalTokens(result: JourneyRunResult | undefined): number | undefined {
	if (!result) return undefined;
	const { input_tokens: i, output_tokens: o } = result;
	if (i == null && o == null) return undefined;
	return (i ?? 0) + (o ?? 0);
}

function countSearches(result: JourneyRunResult | undefined): number {
	return (result?.trajectory?.steps ?? []).filter((s) => s.action === "search").length;
}

// The three canonical journey metrics ora's product shows, computed here from
// the trajectory exactly as the engine does (run-recap.tsx score helpers):
//   · on-site discovery = 1 − web-search share of fetches   (green ≥70, amber ≥40)
//   · reliability       = HTTP-2xx share of non-search fetches (100 green, ≥85 green, ≥60 amber)
//   · link following    = previous-artifact share of fetches (≡ run_signals.link_following_rate)
// Each renders only when it has steps to score, so a search-only run omits them
// rather than printing a fake 0.
interface JourneyMetric {
	label: string;
	pct: number;
	paint: (s: string) => string;
}

function tierColor(pct: number, good: number, warn: number): (s: string) => string {
	return pct >= good ? pc.green : pct >= warn ? pc.yellow : pc.red;
}

function journeyMetrics(result: JourneyRunResult): JourneyMetric[] {
	const steps = result.trajectory?.steps ?? [];
	// Path-origin denominator: fetch / api_call steps (searches excluded).
	const paths = steps.filter(
		(s) => s.type === "tool_call" && (s.action === "fetch" || s.action === "api_call"),
	);
	// Reliability denominator: any non-search tool call that observed a status.
	const fetches = steps.filter((s) => s.type === "tool_call" && s.action && s.action !== "search");

	const metrics: JourneyMetric[] = [];

	if (paths.length) {
		const webSearch =
			paths.filter((s) => s.attribution?.kind === "web_search").length / paths.length;
		const pct = Math.round((1 - webSearch) * 100);
		metrics.push({ label: "on-site discovery", pct, paint: tierColor(pct, 70, 40) });
	}

	if (fetches.length) {
		const ok = fetches.filter((s) => s.status != null && s.status >= 200 && s.status < 300).length;
		const pct = Math.round((ok / fetches.length) * 100);
		metrics.push({
			label: "reliability",
			pct,
			paint: pct === 100 ? pc.green : tierColor(pct, 85, 60),
		});
	}

	if (paths.length) {
		// Prefer the engine's own rate; it is previous_artifact / fetches by definition.
		const rate =
			result.run_signals?.link_following_rate ??
			paths.filter((s) => s.attribution?.kind === "previous_artifact").length / paths.length;
		const pct = Math.round(rate * 100);
		metrics.push({ label: "link following", pct, paint: tierColor(pct, 70, 35) });
	}

	return metrics;
}

// A labelled 0–100% bar, tinted by the metric's own score tier (the same
// green/amber/red coding the product's cards use).
function metricLine(metric: JourneyMetric, cells = 20): string {
	const lit = Math.max(0, Math.min(cells, Math.round((metric.pct / 100) * cells)));
	const bar = `${metric.paint("▰".repeat(lit))}${pc.dim("▱".repeat(cells - lit))}`;
	const pct = `${metric.pct}%`.padStart(4);
	return `  ${pc.dim(metric.label.padEnd(17))}  ${bar}  ${metric.paint(pc.bold(pct))}`;
}

function rule(wide: number): string {
	return pc.dim(`  ${"─".repeat(Math.min(wide - 4, 52))}`);
}

// The behavioral read of the run: the three canonical journey metrics (derived
// from the trajectory, so they show on every completed run) plus the reach /
// intent / layers context from run_signals (experimental, often absent on the
// keyless tier — each renders only when the server sent it).
function signalLines(result: JourneyRunResult): string[] {
	const sig = result.run_signals;
	const rows: string[] = [];

	// Reach context (run_signals only).
	if (sig?.reached_anchor != null) {
		const reach = sig.reached_anchor
			? pc.green("✓ reached the site")
			: pc.red("✗ never reached the site");
		rows.push("", `  ${reach}`);
	}

	// The three canonical journey metrics, tinted by score tier.
	const metrics = journeyMetrics(result);
	if (metrics.length) {
		rows.push("");
		for (const metric of metrics) rows.push(metricLine(metric));
	}

	const layers = sig?.journey_layers ?? result.insight?.journey_layers;
	if (layers?.length) {
		rows.push("", `  ${pc.dim("layers")}  ${layers.map((l) => pc.bold(l)).join(pc.dim(" › "))}`);
	}
	return rows;
}

function renderOutcome(outcome: DeepJourneyOutcome, url: string): string[] {
	const wide = stdoutWidth(60, 120);
	const { detail } = outcome;
	const result = detail.result;
	const lines: string[] = ["", rule(wide), ""];

	// Verdict headline.
	lines.push(
		`  ${verdictLine(detail.verdict, detail.status)}  ${pc.dim("·")}  ${pc.dim(detail.domain ?? url)}`,
	);

	// One chip row: size and cost of the run at a glance.
	const chips: string[] = [];
	if (detail.step_count != null) chips.push(`${detail.step_count} steps`);
	const searches = result?.run_signals?.search_count ?? countSearches(result);
	if (searches) chips.push(`${searches} search${searches === 1 ? "" : "es"}`);
	if (result?.duration_ms != null) chips.push(`${(result.duration_ms / 1000).toFixed(1)}s`);
	const tokens = totalTokens(result);
	if (tokens != null) chips.push(`${chipTokens(tokens)} tokens`);
	if (result?.cost_usd != null) chips.push(chipCost(result.cost_usd));
	if (chips.length) lines.push(`  ${pc.dim(chips.join("  ·  "))}`);

	// Behavioral signals (reach, intent, link-following, layers) when present.
	if (result) lines.push(...signalLines(result));

	// The generated read, wrapped to width; observations as bullets beneath it.
	if (result?.insight?.summary) {
		lines.push("");
		for (const row of flow(plain(result.insight.summary), wide - 4)) lines.push(`  ${row}`);
	}
	const observations = result?.insight?.key_observations ?? [];
	if (observations.length) {
		lines.push("", `  ${pc.bold("Observations")}`);
		for (const observation of observations) {
			const [first, ...rest] = flow(plain(observation), wide - 6);
			lines.push(`    ${pc.cyan("·")} ${first}`);
			for (const row of rest) lines.push(`      ${row}`);
		}
	}

	if (detail.status === "failed") {
		lines.push(
			"",
			pc.dim(
				outcome.engineError
					? `  Engine error: ${outcome.engineError} — re-running is free to try.`
					: "  The run ended in an engine error; re-running is free to try.",
			),
		);
	}

	lines.push("", pc.dim(`  For the 4-layer readiness audit, run: ax audit ${url}`));
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
	// The goal drawn at the graph's root: the free-text task verbatim, or the
	// curated intent's own phrasing (template › hint › label), never a bare id.
	let intentText = task ?? "journey";
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
			const chosen = intents.intents.find((option) => option.id === intentId);
			intentText = chosen?.template || chosen?.hint || chosen?.label || intentId || "journey";
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

	// The live attribution graph draws itself from the streamed trajectory, so
	// it only lights up when we're both on a TTY and actually streaming. With
	// --no-stream (no per-step frames) or a bare pipe, we fall back to the
	// one-line spinner and let the terminal graph print once at the end.
	const live = interactive && !input.noStream;
	const panel = new LivePanel();
	let steps: JourneyStep[] = [];
	let headline = `waking ${agent.label}`;
	const repaint = () => panel.draw(graphLines(steps, intentText, false), headline);

	if (live) {
		console.log();
		console.log(
			`  ${pc.cyan("▶")} ${pc.bold(target)}  ${pc.dim("·")}  ${pc.dim(agentLine(agent))}  ${pc.dim("·")}  ${pc.dim(task ? "custom task" : (intentId ?? "default"))}`,
		);
		console.log();
		panel.open();
		repaint();
	} else if (interactive) {
		spinner.start(`Sending ${agentLine(agent)} to ${target} (${task ? `"${task}"` : intentId})`);
	}

	const progress = (line: string) => {
		if (live) {
			headline = line;
			repaint();
		} else if (interactive) {
			spinner.update(line);
		}
	};

	let outcome: DeepJourneyOutcome;
	try {
		outcome = await performDeepJourney(target, {
			intentId: task ? undefined : intentId,
			task,
			apiKey,
			harness: agent.harness,
			model: agent.model,
			noStream: input.noStream,
			progress: interactive ? progress : undefined,
			onTrajectory: live
				? (raw) => {
						steps = raw.map(toGraphStep);
						repaint();
					}
				: undefined,
		});
	} catch (error) {
		if (live) panel.close();
		else if (interactive) spinner.stop();
		if (error instanceof DeepJourneyApiError) return fail(error.message);
		return fail(error instanceof Error ? error.message : String(error));
	}
	if (live) panel.close();
	else if (interactive) spinner.stop();

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

	// The permanent copy: redraw the graph from the terminal detail's trajectory
	// (the authoritative, complete tree - which can carry more steps than the
	// last stream frame did) so the attribution picture survives past the live
	// region and also shows up on a bare pipe or under --no-stream.
	const finalSteps = (outcome.detail.result?.trajectory?.steps ?? []).map(toGraphStep);
	if (finalSteps.length) {
		console.log();
		for (const line of graphLines(finalSteps, intentText, true)) console.log(line);
	}

	for (const line of renderOutcome(outcome, target)) console.log(line);
	return outcome.detail.status === "failed" ? EXIT.RUN_FAILED : EXIT.OK;
}
