import pc from "picocolors";
import { SPINNER_FRAMES } from "./ansi";

// Single-line progress indicator on stderr, used while a scan streams.
// It only animates when stderr is an interactive terminal; in pipes and CI the
// carriage-return repaint would otherwise show up as one line per tick.

const TICK_MS = 80;

let handle: ReturnType<typeof setInterval> | undefined;
let tick = 0;
let label = "";

function paint(): void {
	const glyph = pc.cyan(SPINNER_FRAMES[tick % SPINNER_FRAMES.length]);
	// Cap the label at the terminal width so the line can never soft-wrap and
	// defeat the \r redraw; \x1b[K erases leftovers from a longer prior label.
	const cap = Math.max(10, (process.stderr.columns ?? 80) - 2);
	const shown = label.length > cap ? `${label.slice(0, cap - 1)}…` : label;
	process.stderr.write(`\r\x1b[K${glyph} ${pc.dim(shown)}`);
	tick++;
}

export const spinner = {
	start(message: string): void {
		spinner.stop();
		tick = 0;
		label = message;
		if (!process.stderr.isTTY) return;
		handle = setInterval(paint, TICK_MS);
	},

	/** Swap the message; the running timer picks it up on the next tick. */
	update(message: string): void {
		label = message;
	},

	stop(): void {
		if (!handle) return;
		clearInterval(handle);
		handle = undefined;
		process.stderr.write("\r\x1b[K");
	},
};
