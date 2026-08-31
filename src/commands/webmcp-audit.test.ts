import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebmcpIngestError } from "../webmcp/ingest";
import type { PublicWebmcpAudit } from "../webmcp/vendor/projection";
import type { WebmcpCaptureResult } from "../webmcp/vendor/types";

// The three modules the command orchestrates. Faking them is what lets this
// file assert the exit-code contract without a browser or a network.
vi.mock("../webmcp/chrome", async (importOriginal) => ({
	...(await importOriginal<typeof import("../webmcp/chrome")>()),
	resolveChrome: vi.fn(),
}));
vi.mock("../webmcp/capture", () => ({ captureLocally: vi.fn() }));
vi.mock("../webmcp/ingest", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../webmcp/ingest")>();
	return { ...actual, ingestCapture: vi.fn() };
});

import { captureLocally } from "../webmcp/capture";
import { resolveChrome } from "../webmcp/chrome";
import { ingestCapture } from "../webmcp/ingest";
import { EXIT, webmcpAuditCommand } from "./webmcp-audit";

const CAPTURE = JSON.parse(
	readFileSync(new URL("../webmcp/__fixtures__/ora-ai-capture.json", import.meta.url), "utf8"),
) as WebmcpCaptureResult;
const AUDIT = (
	JSON.parse(
		readFileSync(new URL("../webmcp/__fixtures__/ora-ai-audit.json", import.meta.url), "utf8"),
	) as { audit: PublicWebmcpAudit }
).audit;

const BASE = { url: "http://localhost:3000", json: true, showPassing: false };

beforeEach(() => {
	vi.mocked(resolveChrome).mockResolvedValue({
		ok: true,
		endpoint: { webSocketDebuggerUrl: "ws://127.0.0.1:9222/x", product: "151.0.0.0" },
		close: vi.fn(async () => {}),
		launched: true,
	});
	vi.mocked(captureLocally).mockResolvedValue(CAPTURE);
	vi.mocked(ingestCapture).mockResolvedValue(AUDIT);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("exit codes", () => {
	it("0 when the audit comes back", async () => {
		expect(await webmcpAuditCommand({ ...BASE })).toBe(EXIT.OK);
	});

	it("1 when the score is below --min-score", async () => {
		// The fixture scores 77 with the grade withheld - a threshold keyed on
		// the grade would let this through, which is why it reads the score.
		expect(await webmcpAuditCommand({ ...BASE, minScore: "90" })).toBe(EXIT.BELOW_MIN_SCORE);
	});

	it("0 when the score clears --min-score even with the grade withheld", async () => {
		expect(await webmcpAuditCommand({ ...BASE, minScore: "70" })).toBe(EXIT.OK);
	});

	it("2 on a URL with no scheme it can drive", async () => {
		expect(await webmcpAuditCommand({ ...BASE, url: "not a url" })).toBe(EXIT.USAGE);
	});

	it("2 on a --min-score that is not an integer 0-100", async () => {
		for (const bad of ["abc", "", "101", "-1", "70.5"]) {
			expect(await webmcpAuditCommand({ ...BASE, minScore: bad }), bad).toBe(EXIT.USAGE);
		}
	});

	it("2 when no debuggable Chrome answers", async () => {
		// A browser we cannot reach has a fix the developer can act on; calling
		// it an API error would point them at ora instead of at their terminal.
		vi.mocked(resolveChrome).mockResolvedValue({ ok: false, message: "no Chrome" });
		expect(await webmcpAuditCommand({ ...BASE })).toBe(EXIT.USAGE);
		expect(ingestCapture).not.toHaveBeenCalled();
	});

	it("2 when the page never loaded, without spending an ingest", async () => {
		const page = { ...CAPTURE.pages[0], error: "net::ERR_CONNECTION_REFUSED" };
		vi.mocked(captureLocally).mockResolvedValue({ ...CAPTURE, pages: [page] });
		expect(await webmcpAuditCommand({ ...BASE })).toBe(EXIT.USAGE);
		expect(ingestCapture).not.toHaveBeenCalled();
	});

	it("2 when the capture would be refused, without spending an ingest", async () => {
		vi.mocked(captureLocally).mockResolvedValue({ ...CAPTURE, shimVersion: "99" });
		expect(await webmcpAuditCommand({ ...BASE })).toBe(EXIT.USAGE);
		expect(ingestCapture).not.toHaveBeenCalled();
	});

	it("1, not 3, when the gate turned the page away and --min-score is set", async () => {
		// No score exists for a not-ready page. Reporting that as an API error
		// would tell CI the call failed, when the call worked and the answer is
		// that the page is not agent-ready.
		vi.mocked(ingestCapture).mockResolvedValue({
			...AUDIT,
			score: null,
			grade: null,
			availability: { status: "not-ready", reasons: [{ id: "no-tools", detail: "No tools." }] },
		});
		expect(await webmcpAuditCommand({ ...BASE, minScore: "70" })).toBe(EXIT.BELOW_MIN_SCORE);
	});

	it("0 for a not-ready page when no threshold was asked for", async () => {
		// The audit ran and answered; without --min-score there is nothing to
		// fail against.
		vi.mocked(ingestCapture).mockResolvedValue({
			...AUDIT,
			score: null,
			grade: null,
			availability: { status: "not-ready", reasons: [{ id: "no-tools", detail: "No tools." }] },
		});
		expect(await webmcpAuditCommand({ ...BASE })).toBe(EXIT.OK);
	});

	it("3 when ora refuses or cannot be reached", async () => {
		vi.mocked(ingestCapture).mockRejectedValue(
			new WebmcpIngestError("upgrade ax", { code: "SHIM_VERSION_MISMATCH" }),
		);
		expect(await webmcpAuditCommand({ ...BASE })).toBe(EXIT.API);
	});

	it("3 when the capture itself throws", async () => {
		vi.mocked(captureLocally).mockRejectedValue(new Error("the browser went away"));
		expect(await webmcpAuditCommand({ ...BASE })).toBe(EXIT.API);
	});
});

describe("what reaches ora", () => {
	it("sends the normalized url beside the capture", async () => {
		await webmcpAuditCommand({ ...BASE, url: "localhost:3000" });
		const [url, capture] = vi.mocked(ingestCapture).mock.calls[0];
		// A bare host:port is read as http, not https: this command drives a dev
		// server, and defaulting to https would fail every plain-http one.
		expect(url).toBe("http://localhost:3000/");
		expect(capture.shimVersion).toBe("1");
	});

	it("prints the payload exactly as ora served it under --json", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await webmcpAuditCommand({ ...BASE, json: true });
		expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual(AUDIT);
	});
});

describe("warnings the reader must not miss", () => {
	it("puts the browser-parity warning on stderr, in --json too", async () => {
		// --json is what CI runs, and its stdout has to stay the raw payload -
		// so a warning that the capture will not match ora goes to stderr, in
		// both modes. Suppressing it under --json would hide it exactly where
		// nobody is watching the terminal.
		const page = {
			...CAPTURE.pages[0],
			consumer: { ...CAPTURE.pages[0].consumer, nativeApi: true },
		};
		vi.mocked(captureLocally).mockResolvedValue({ ...CAPTURE, pages: [page] });
		const err = vi.spyOn(console, "error").mockImplementation(() => {});

		await webmcpAuditCommand({ ...BASE, json: true });

		const stderr = err.mock.calls.map((c) => String(c[0])).join("\n");
		expect(stderr).toMatch(/WebMCPTesting/);
		expect(stderr).toMatch(/ora captures with a browser that does not/);
		expect(stderr).toMatch(/availability reason/);
	});

	it("says nothing about parity when the browser provided no WebMCP", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		await webmcpAuditCommand({ ...BASE, json: true });
		expect(err.mock.calls.map((c) => String(c[0])).join("\n")).not.toMatch(/WebMCPTesting/);
	});
});
