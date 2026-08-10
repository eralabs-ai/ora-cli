#!/usr/bin/env node
// Post-build smoke test for the bundled CLI.
//
// tsup inlines package.json at build time (src/main.ts imports it), so a build
// that ran *before* a version bump would publish a binary whose `ax --version`
// lies. The release workflow bumps then builds; this asserts that ordering held.
// Also checks the things that break `npx @ora-ai/ax` but never break `pnpm test`:
// a missing shebang or a non-executable bin.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const BIN = "dist/main.cjs";
const failures = [];

function check(label, fn) {
	try {
		fn();
		console.log(`  ok    ${label}`);
	} catch (error) {
		failures.push(`${label}: ${error.message}`);
		console.log(`  FAIL  ${label}`);
	}
}

function ax(args) {
	return execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8" }).trim();
}

const expectedVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

console.log(`smoke: ${BIN} (expecting v${expectedVersion})`);

check("bin is executable", () => {
	const mode = statSync(BIN).mode;
	if (!(mode & 0o111)) throw new Error("missing executable bit");
});

check("bin has a node shebang", () => {
	const head = readFileSync(BIN, "utf8").slice(0, 32);
	if (!head.startsWith("#!/usr/bin/env node")) throw new Error(`starts with ${head.slice(0, 20)}`);
});

check("--version matches package.json", () => {
	const actual = ax(["--version"]);
	if (actual !== expectedVersion) throw new Error(`got "${actual}", want "${expectedVersion}"`);
});

check("--help exits 0 and lists both commands", () => {
	const help = ax(["--help"]);
	for (const command of ["scan", "journey"]) {
		if (!help.includes(command)) throw new Error(`help omits "${command}"`);
	}
});

check("scan --help exits 0", () => ax(["scan", "--help"]));
check("journey --help exits 0", () => ax(["journey", "--help"]));

if (failures.length > 0) {
	console.error(`\nsmoke failed (${failures.length}):`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}

console.log("\nsmoke passed");
