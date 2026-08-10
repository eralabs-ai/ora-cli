// Small terminal-text helpers shared by the journey renderer. All width math in
// this package operates on plain strings; color is applied to whole lines only,
// after wrapping, so ANSI escapes can never skew column calculations.

/** Current stdout width clamped into [lo, hi]; 100 when not a terminal. */
export function stdoutWidth(lo: number, hi: number): number {
	const cols = process.stdout.columns ?? 100;
	return Math.min(hi, Math.max(lo, cols));
}

/** Collapse runs of whitespace and cap at `max` chars with a trailing ellipsis. */
export function squeeze(value: string, max: number): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Greedy word wrap (no hard-breaking); collapses whitespace first. */
export function flow(value: string, max: number): string[] {
	const out: string[] = [];
	let current = "";
	for (const word of value.replace(/\s+/g, " ").trim().split(" ")) {
		if (current && current.length + 1 + word.length > max) {
			out.push(current);
			current = word;
		} else {
			current = current ? `${current} ${word}` : word;
		}
	}
	if (current) out.push(current);
	return out;
}

/**
 * Pulse frames shared by the audit spinner and the journey panel — a breathing
 * diamond, echoing the ◆ intent marker in the journey graph. Every frame is a
 * single-cell glyph so `.length` math stays valid; frames are doubled so the
 * pulse breathes smoothly at the 80ms tick.
 */
export const SPINNER_FRAMES = ["◇", "◇", "◈", "◈", "◆", "◆", "◈", "◈"];
