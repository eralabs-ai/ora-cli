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

	private repaint(): void {
		if (!this.live) return;
		const frame = [this.banner(), "", ...this.content];
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
