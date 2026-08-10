import pc from "picocolors";
import type { JourneyStep } from "../api/platform";
import { squeeze, stdoutWidth } from "./ansi";

// Builds and draws the journey graph — the same picture the ora product shows:
// the intent at the root, every tool action as a rounded box beneath it, and
// edges taken from ora's own per-step attribution rather than guessed. The
// agent's reasoning shows up in the graph itself as (…) markers on the edge
// above the action it produced.
//
// Two deliberate choices, learned from user feedback on the product:
//   · No synthetic "homepage" node — it would claim a fetch that never
//     happened. A real homepage fetch appears as an ordinary fetch box.
//   · Reasoning is placed, not just counted.

export type NodeTone = "root" | "ok" | "redirect" | "error" | "active";

export interface GraphNode {
	id: number;
	kind: "intent" | "search" | "fetch";
	icon: string;
	label: string;
	meta?: string;
	tone: NodeTone;
	/** One-line reasoning notes attached above this box. */
	notes: string[];
	children: GraphNode[];
}

export interface JourneyTree {
	root: GraphNode;
	/** Reasoning with no action after it yet — drawn under the graph. */
	looseNotes: string[];
}

/** Pull host + path out of free-form text like `GET https://x.dev/docs`. */
export function splitUrl(text?: string): { host?: string; path?: string } {
	if (!text) return {};
	const hit = text.match(/https?:\/\/([^/\s]+)(\/\S*)?/i);
	return hit ? { host: hit[1], path: hit[2] ?? "/" } : {};
}

export function isSearchStep(step: JourneyStep): boolean {
	return /search/i.test(`${step.tool ?? ""} ${step.action ?? ""}`);
}

// ⚠ Icon set is fixed on purpose: 🔍 🌐 📄 have .length === 2 AND occupy two
// columns, while ◆ is 1/1 — so plain .length still equals display width and
// the box borders line up. Vet any new icon against both properties.
function iconFor(step: JourneyStep): string {
	if (isSearchStep(step)) return "🔍";
	const hint = `${step.tool ?? ""} ${step.action ?? ""}`.toLowerCase();
	if (/fetch|http|get/.test(hint)) return "🌐";
	if (/read|open|view/.test(hint)) return "📄";
	return "🌐";
}

function nodeFor(step: JourneyStep, labelCap: number): GraphNode {
	if (isSearchStep(step)) {
		const query = step.input_display ?? String(step.input?.query ?? "search");
		const hits = step.output_structured?.links?.length;
		return {
			id: step.id,
			kind: "search",
			icon: "🔍",
			label: squeeze(`"${query}"`, labelCap),
			meta: hits ? `${hits} results` : undefined,
			tone: "ok",
			notes: [],
			children: [],
		};
	}

	const { host, path } = splitUrl(step.input_display ?? String(step.input?.url ?? ""));
	const code = step.status;
	const bounced = code != null && code >= 300 && code < 400;
	const failed = Boolean(step.is_error) || (code != null && code >= 400);

	let meta: string;
	if (bounced) meta = `↳ ${code}`;
	else if (failed) meta = `✗ ${code ?? "error"}`;
	else {
		const chips = ["✓"];
		if (code) chips.push(String(code));
		if (step.duration_ms) chips.push(`${(step.duration_ms / 1000).toFixed(1)}s`);
		meta = chips.join(" ");
	}

	return {
		id: step.id,
		kind: "fetch",
		icon: iconFor(step),
		label: squeeze(`${host ?? "?"}${path ?? ""}`, labelCap),
		meta,
		tone: bounced ? "redirect" : failed ? "error" : "ok",
		notes: [],
		children: [],
	};
}

/**
 * One pass over the trajectory. Reasoning queues up and attaches to the next
 * action's box. Parents are picked strongest-signal-first:
 *   1. attribution.referrer.step_id — ora's explicit "found on step N" edge
 *   2. attribution.kind "web_search"        → newest search box
 *   3. attribution.kind "previous_artifact" → previous fetch box
 *   4. anything else (prior knowledge, direct) → the intent root
 * Searches always hang off the root.
 */
export function buildJourneyTree(
	steps: JourneyStep[],
	intent: string,
	settled: boolean,
): JourneyTree {
	const wide = stdoutWidth(60, 120);
	const labelCap = Math.min(52, Math.max(24, wide - 40));
	const noteCap = Math.max(30, wide - 24);

	const root: GraphNode = {
		id: -1,
		kind: "intent",
		icon: "◆",
		label: squeeze(intent, noteCap),
		tone: "root",
		notes: [],
		children: [],
	};

	const nodesByStep = new Map<number, GraphNode>();
	let queuedNotes: string[] = [];
	let recentSearch: GraphNode | undefined;
	let recentFetch: GraphNode | undefined;
	let newest: GraphNode | undefined;

	for (const step of steps) {
		if (step.type === "text" && step.kind === "reasoning") {
			const note = (step.thinking ?? step.text ?? "").trim();
			if (note) queuedNotes.push(squeeze(note, noteCap));
			continue;
		}
		if (step.type !== "tool_call") continue;

		const node = nodeFor(step, labelCap);
		node.notes = queuedNotes;
		queuedNotes = [];
		nodesByStep.set(step.id, node);

		let parent = root;
		if (!isSearchStep(step)) {
			const refStep = step.attribution?.referrer?.step_id;
			const via = step.attribution?.kind;
			const referred = refStep != null ? nodesByStep.get(refStep) : undefined;
			if (referred && referred !== node) parent = referred;
			else if (via === "web_search" && recentSearch) parent = recentSearch;
			else if (via === "previous_artifact" && recentFetch) parent = recentFetch;
		}
		parent.children.push(node);

		if (isSearchStep(step)) recentSearch = node;
		else recentFetch = node;
		newest = node;
	}

	if (newest && !settled) {
		newest.tone = "active";
		newest.meta = "…";
	}
	return { root, looseNotes: queuedNotes };
}

/** "9 steps · 3 reasoning · 1 search" — zero parts omitted (except the total). */
export function journeySummary(steps: JourneyStep[]): string {
	const thinking = steps.filter((s) => s.kind === "reasoning").length;
	const searching = steps.filter((s) => s.type === "tool_call" && isSearchStep(s)).length;
	const parts = [`${pc.bold(String(steps.length))} steps`];
	if (thinking) parts.push(`${pc.bold(String(thinking))} reasoning`);
	if (searching) parts.push(`${pc.bold(String(searching))} search${searching === 1 ? "" : "es"}`);
	return parts.join(pc.dim("  ·  "));
}

// --- Drawing ---
// Each box is three lines. A parent with children opens a trunk (`╰─┬`) from
// its bottom border; every child gets an elbow (`├──` / `╰──`) that merges
// into its own left border (`┤`). Prefixes are exactly five columns, so each
// depth level indents by five and the trunk stays under the parent's ┬.

function tonePalette(tone: NodeTone): { frame: Paint; ink: Paint } {
	switch (tone) {
		case "root":
			return { frame: pc.dim, ink: (s) => pc.bold(s) };
		case "active":
			return { frame: pc.cyan, ink: (s) => pc.cyan(pc.bold(s)) };
		case "redirect":
			return { frame: pc.yellow, ink: pc.yellow };
		case "error":
			return { frame: pc.red, ink: pc.red };
		default:
			return { frame: pc.green, ink: pc.green };
	}
}

type Paint = (s: string) => string;

const noteLine = (note: string) => pc.dim(`(…) ${note}`);

function drawNode(node: GraphNode, joined: boolean): string[] {
	const { frame, ink } = tonePalette(node.tone);
	const bare = `${node.icon} ${node.label}${node.meta ? ` ${node.meta}` : ""}`;
	const span = bare.length + 2; // one space of padding each side
	const dressed = `${node.icon} ${ink(node.label)}${node.meta ? ` ${pc.dim(node.meta)}` : ""}`;
	const branching = node.children.length > 0;

	const out = node.notes.map(noteLine);
	out.push(frame(`╭${"─".repeat(span)}╮`));
	out.push(`${frame(joined ? "┤" : "│")} ${dressed} ${frame("│")}`);
	out.push(frame(branching ? `╰─┬${"─".repeat(span - 2)}╯` : `╰${"─".repeat(span)}╯`));

	node.children.forEach((child, idx) => {
		const closing = idx === node.children.length - 1;
		const block = drawNode(child, true);
		const doorway = child.notes.length + 1; // the child's mid (border) line
		block.forEach((row, at) => {
			let lead: string;
			if (at === doorway) lead = closing ? "  ╰──" : "  ├──";
			else if (at < doorway) lead = "  │  ";
			else lead = closing ? "     " : "  │  ";
			out.push(pc.dim(lead) + row);
		});
	});
	return out;
}

export function drawJourneyTree(tree: JourneyTree): string[] {
	const rows = drawNode(tree.root, false);
	if (tree.looseNotes.length) {
		rows.push("");
		rows.push(...tree.looseNotes.map(noteLine));
	}
	return rows;
}
