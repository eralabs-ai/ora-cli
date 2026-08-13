import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILT_AGAINST, isNewerContract, resetContractWarning, warnOnNewerContract } from ".";

describe("isNewerContract", () => {
	it("is false for the built version, older versions, and patch drift", () => {
		expect(isNewerContract(BUILT_AGAINST)).toBe(false);
		expect(isNewerContract("1.0.0")).toBe(false);
		expect(isNewerContract("0.9.0")).toBe(false);
		const [major, minor, patch] = BUILT_AGAINST.split(".").map(Number);
		expect(isNewerContract(`${major}.${minor}.${patch + 3}`)).toBe(false);
	});

	it("is true for a newer minor and a newer major", () => {
		const [major, minor] = BUILT_AGAINST.split(".").map(Number);
		expect(isNewerContract(`${major}.${minor + 1}.0`)).toBe(true);
		expect(isNewerContract(`${major + 1}.0.0`)).toBe(true);
	});

	it("is false for absent or malformed versions", () => {
		expect(isNewerContract(undefined)).toBe(false);
		expect(isNewerContract("")).toBe(false);
		expect(isNewerContract("not-semver")).toBe(false);
	});
});

describe("warnOnNewerContract", () => {
	afterEach(() => {
		resetContractWarning();
		vi.restoreAllMocks();
	});

	it("writes one stderr line per process, only for newer contracts", () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const [major, minor] = BUILT_AGAINST.split(".").map(Number);
		const newer = `${major}.${minor + 1}.0`;

		warnOnNewerContract(BUILT_AGAINST);
		expect(write).not.toHaveBeenCalled();

		warnOnNewerContract(newer);
		warnOnNewerContract(newer);
		expect(write).toHaveBeenCalledTimes(1);
		expect(String(write.mock.calls[0][0])).toContain(newer);
		expect(String(write.mock.calls[0][0])).toContain(BUILT_AGAINST);
	});
});
