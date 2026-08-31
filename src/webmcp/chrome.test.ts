import { describe, expect, it } from "vitest";
import { resolveChrome, webmcpParityWarning } from "./chrome";
import type { WebmcpCaptureResult, WebmcpPageCapture } from "./vendor/types";

/** A capture carrying only what the parity warning reads. */
function captureWithNativeApi(nativeApi: boolean): WebmcpCaptureResult {
	const page = {
		consumer: { nativeApi, originTrial: null, permissionsPolicy: null, iframeAllow: null },
	} as unknown as WebmcpPageCapture;
	return { pages: [page] } as unknown as WebmcpCaptureResult;
}

describe("resolveChrome", () => {
	it("names the endpoint the caller gave when nothing answers there", async () => {
		// A typo in --chrome-endpoint has to be echoed back. Falling through to
		// the default port would report a problem with a machine the developer
		// never mentioned.
		const result = await resolveChrome("127.0.0.1:1");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("127.0.0.1:1");
	});

	it("tells a developer how to start Chrome, and never how to download one", async () => {
		// Design decision #6: this package attaches to a browser the developer
		// already has. A download prompt here would make the CLI a distributor.
		const result = await resolveChrome("127.0.0.1:1");
		if (result.ok) throw new Error("expected no browser on port 1");
		expect(result.message).toContain("--remote-debugging-port");
		expect(result.message).toContain("never downloads one");
		// No vendored browser, and no suggestion of one: naming a downloader
		// here is what would turn this package into a distributor.
		expect(result.message).not.toMatch(/playwright|puppeteer|chrome-launcher/i);
	});
});

describe("webmcpParityWarning", () => {
	it("says nothing when the browser provided no WebMCP of its own", () => {
		// The ordinary case, and the one that matches ora's capture browser.
		expect(webmcpParityWarning(captureWithNativeApi(false))).toBeNull();
	});

	it("warns, and names the divergence, when the browser provided WebMCP", () => {
		// Measured, not assumed: one page captured twice by identical code reads
		// `testing-only` on a stock Chrome and `active` on one started with
		// --enable-features=WebMCPTesting.
		const warning = webmcpParityWarning(captureWithNativeApi(true));
		expect(warning).not.toBeNull();
		expect(warning).toContain("WebMCPTesting");
		// It reports the browser and defers to the finding. Claiming a specific
		// check moved would mean reimplementing a condition ora owns - and ora
		// only annotates when the native-API claim is what carried the pass, so
		// a page with a valid origin trial would make that claim a lie.
		expect(warning).toMatch(/availability reason/);
		expect(warning).not.toMatch(/\bnot agent-ready\b|\bgrade\b/);
	});
});
