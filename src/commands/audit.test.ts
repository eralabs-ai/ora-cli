import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import realAuditScan from "../api/__fixtures__/audit-scan.json";
import * as api from "../api/audit";
import type { AuditScanResult } from "../contract";
import { auditCommand, EXIT } from "./audit";

vi.mock("../api/audit", async (importOriginal) => {
	const original = await importOriginal<typeof api>();
	return { ...original, performAudit: vi.fn() };
});

const FIXTURE = realAuditScan as unknown as AuditScanResult;

const resolveWith = (extra: Partial<AuditScanResult> = {}) =>
	vi.mocked(api.performAudit).mockResolvedValue({ result: { ...FIXTURE, ...extra } });

const run = (over: Partial<Parameters<typeof auditCommand>[0]> = {}) =>
	auditCommand({
		url: "example.com",
		json: true, // no spinner / renderer noise in tests
		showSkipped: false,
		showPassing: false,
		force: false,
		...over,
	});

describe("auditCommand exit codes", () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	it("0 on success", async () => {
		resolveWith();
		expect(await run()).toBe(EXIT.OK);
	});

	it("0 when the score meets --min-score, 1 when it is below", async () => {
		resolveWith({ score: 42 });
		expect(await run({ minScore: "42" })).toBe(EXIT.OK);
		resolveWith({ score: 42 });
		expect(await run({ minScore: "43" })).toBe(EXIT.BELOW_MIN_SCORE);
	});

	it("2 on a malformed URL without calling the API", async () => {
		const perform = vi.mocked(api.performAudit);
		expect(await run({ url: "not a url" })).toBe(EXIT.USAGE);
		expect(await run({ url: "" })).toBe(EXIT.USAGE);
		expect(await run({ url: "http://" })).toBe(EXIT.USAGE);
		expect(perform).not.toHaveBeenCalled();
	});

	it("2 on an unparseable --min-score or --max-age", async () => {
		const perform = vi.mocked(api.performAudit);
		expect(await run({ minScore: "seventy" })).toBe(EXIT.USAGE);
		expect(await run({ minScore: "101" })).toBe(EXIT.USAGE);
		expect(await run({ minScore: "-1" })).toBe(EXIT.USAGE);
		expect(await run({ maxAge: "6h" })).toBe(EXIT.USAGE);
		expect(perform).not.toHaveBeenCalled();
	});

	it("3 when the API is unreachable or rate limited", async () => {
		vi.mocked(api.performAudit).mockRejectedValue(new api.AuditApiError("ora rate limit exceeded"));
		expect(await run()).toBe(EXIT.API);
	});

	it("accepts bare domains and full URLs", async () => {
		resolveWith();
		expect(await run({ url: "example.com" })).toBe(EXIT.OK);
		resolveWith();
		expect(await run({ url: "https://docs.example.com/path/" })).toBe(EXIT.OK);
	});

	it("threads --force and --max-age to the client", async () => {
		resolveWith();
		await run({ force: true, maxAge: "7200" });
		expect(vi.mocked(api.performAudit)).toHaveBeenCalledWith(
			"example.com",
			expect.objectContaining({ force: true, maxAgeSeconds: 7200 }),
		);
	});

	it("skips the gate for an auth-gated MCP result (unscored, not failed)", async () => {
		resolveWith({ mcpAuthRequired: true, score: 0, grade: "F" });
		expect(await run({ minScore: "70" })).toBe(EXIT.OK);
	});

	it("--json prints the raw payload byte-for-byte", async () => {
		resolveWith();
		const write = vi.mocked(process.stdout.write);
		await run();
		const printed = write.mock.calls.map((c) => String(c[0])).join("");
		expect(JSON.parse(printed)).toEqual(FIXTURE);
	});
});
