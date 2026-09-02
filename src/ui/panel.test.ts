import { afterEach, describe, expect, it, vi } from "vitest";
import { LivePanel } from "./panel";

// The live region redraws in place with an absolute cursor-up, which can only
// reach the top of the viewport. A frame taller than the terminal would scroll
// and the repaint would stack ghost copies (the deep-journey duplication bug).
// These lock in that every painted frame fits the viewport.

describe("LivePanel viewport clamp", () => {
	afterEach(() => vi.restoreAllMocks());

	function paintAndCapture(rows: number, content: string[]): string {
		const priorTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		const priorRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
		let written = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			written += String(chunk);
			return true;
		});
		try {
			const panel = new LivePanel();
			panel.draw(content, "working");
			return written;
		} finally {
			if (priorTTY) Object.defineProperty(process.stdout, "isTTY", priorTTY);
			if (priorRows) Object.defineProperty(process.stdout, "rows", priorRows);
		}
	}

	it("never paints more lines than the viewport holds", () => {
		const content = Array.from({ length: 200 }, (_, i) => `  box ${i}`);
		const written = paintAndCapture(24, content);
		// Count the content rows actually emitted (each frame line is "\x1b[2K…\n").
		const painted = written.split("\n").length - 1;
		expect(painted).toBeLessThanOrEqual(24);
	});

	it("keeps the newest lines and marks how many were hidden", () => {
		const content = Array.from({ length: 200 }, (_, i) => `  box ${i}`);
		const written = paintAndCapture(24, content);
		expect(written).toContain("box 199"); // the tail (newest) survives
		expect(written).toContain("earlier lines"); // the hidden-count marker
		expect(written).not.toContain("box 0"); // the head is dropped, not stacked
	});

	it("leaves short content untouched", () => {
		const written = paintAndCapture(40, ["  only", "  three", "  lines"]);
		expect(written).toContain("only");
		expect(written).toContain("lines");
		expect(written).not.toContain("earlier line");
	});

	it("keeps the in-place cursor-up within the viewport as the region grows", () => {
		const priorTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		const priorRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const VIEWPORT = 20;
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: VIEWPORT, configurable: true });
		let written = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			written += String(chunk);
			return true;
		});
		try {
			const panel = new LivePanel();
			// Redraw a region that keeps growing well past the viewport height.
			for (let n = 1; n <= 100; n++) {
				panel.draw(
					Array.from({ length: n }, (_, i) => `  box ${i}`),
					"working",
				);
			}
			// Every in-place jump-up (ESC[NA) must stay within the viewport; a value
			// larger than the screen is exactly what scrolled and stacked ghosts.
			// (Swap the ESC byte for a literal so the matcher carries no control char.)
			const jumps = [...written.replaceAll("\x1b", "ESC").matchAll(/ESC\[(\d+)A/g)].map((m) =>
				Number(m[1]),
			);
			expect(jumps.length).toBeGreaterThan(0);
			expect(Math.max(...jumps)).toBeLessThanOrEqual(VIEWPORT);
		} finally {
			if (priorTTY) Object.defineProperty(process.stdout, "isTTY", priorTTY);
			if (priorRows) Object.defineProperty(process.stdout, "rows", priorRows);
		}
	});
});
