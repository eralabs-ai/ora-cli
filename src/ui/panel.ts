import pc from "picocolors";
import { SPINNER_FRAMES } from "./ansi";

// A live region that owns the bottom of the screen while a journey runs. The
// whole graph is repainted in place on every trajectory snapshot (that full
// redraw is what makes it feel alive); between snapshots — gaps of 5–8s —
// only the top status line pulses. Painting is per-line erase-and-rewrite
// (\x1b[2K), never a screen clear, which keeps the redraw flicker-free.
// On a non-TTY every method is a no-op; the caller prints the final graph once.

export class LivePanel {
	private rows = 0;
	private beat = 0;
	private readonly bornAt = Date.now();
	private ticker: ReturnType<typeof setInterval> | undefined;
	private readonly live = Boolean(process.stdout.isTTY);
	private content: string[] = [];
	private headline = "";

	open(): void {
		if (this.live && !this.ticker) this.ticker = setInterval(() => this.pulse(), 100);
	}

	draw(content: string[], headline: string): void {
		this.content = content;
		this.headline = headline;
		this.repaint();
	}

	/** Stop and erase the region so a permanent copy can be printed below. */
	close(): void {
		if (this.ticker) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
		if (this.live && this.rows > 0) {
			process.stdout.write(`\x1b[${this.rows}A\r\x1b[0J`);
			this.rows = 0;
		}
	}

	private banner(): string {
		const glyph = pc.cyan(SPINNER_FRAMES[this.beat % SPINNER_FRAMES.length]);
		const elapsed = Math.floor((Date.now() - this.bornAt) / 1000);
		const full = `${this.headline}  ${elapsed}s`;
		const cap = Math.max(10, (process.stdout.columns ?? 80) - 6);
		const text = full.length > cap ? `${full.slice(0, cap - 1)}…` : full;
		return `  ${glyph} ${pc.bold(text)}`;
	}

	// The live region repaints itself in place with an absolute cursor-up
	// (\x1b[NA), which can only reach the top of the *viewport* — never into
	// scrollback. So a frame taller than the terminal would scroll, the cursor
	// math would under-shoot, and every repaint would stack a fresh ghost copy
	// below the last (and close() could no longer erase them). We bound the
	// frame to the viewport: banner + a blank + as much content as fits, kept
	// from the TAIL (the newest, most interesting nodes) with a marker for the
	// rest. The caller prints the full, untruncated view once at the end.
	private clamp(content: string[]): string[] {
		const budget = Math.max(2, (process.stdout.rows ?? 24) - 3); // banner + blank + slack
		if (content.length <= budget) return content;
		const shown = budget - 1; // ≥ 1: one line reserved for the "earlier lines" marker
		const hidden = content.length - shown;
		return [
			pc.dim(`  ⋯ ${hidden} earlier line${hidden === 1 ? "" : "s"}`),
			...content.slice(-shown),
		];
	}

	private repaint(): void {
		if (!this.live) return;
		const frame = [this.banner(), "", ...this.clamp(this.content)];
		let out = this.rows > 0 ? `\x1b[${this.rows}A` : "";
		for (const row of frame) out += `\x1b[2K${row}\n`;
		if (frame.length < this.rows) out += "\x1b[0J"; // wipe leftovers of a taller frame
		this.rows = frame.length;
		process.stdout.write(out);
	}

	// 100ms heartbeat: rewrite just the banner, hop back down, touch nothing else.
	private pulse(): void {
		if (!this.live || this.rows === 0) return;
		this.beat++;
		process.stdout.write(`\x1b[${this.rows}A\r\x1b[2K${this.banner()}\x1b[${this.rows}B\r`);
	}
}
