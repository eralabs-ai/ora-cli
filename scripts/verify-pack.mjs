#!/usr/bin/env node
// Verifies the publishable tarball before it reaches npm.
//
// The failure this exists to catch is publishing without a build: `npm publish`
// happily ships a tarball with no `dist/`, and the broken version can never be
// reused. npm force-includes the `bin` target even when `files` omits it, so a
// present-and-sane bin is a direct proxy for "the build actually ran".
//
// Also asserts no real .env slips in alongside .env.example.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// A truncated or empty bundle would still be "present". The real bundle is
// ~110KB; this floor only catches something that went badly wrong.
const MIN_BIN_BYTES = 1024;

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

const stdout = execFileSync("npm", ["pack", "--dry-run", "--json"], {
	encoding: "utf8",
	stdio: ["ignore", "pipe", "inherit"],
});

const [tarball] = JSON.parse(stdout);
const byPath = new Map(tarball.files.map((file) => [file.path, file]));

console.log(
	`tarball: ${tarball.name}@${tarball.version} — ${tarball.entryCount} files, ${tarball.size} bytes`,
);
for (const file of tarball.files) console.log(`  ${file.path} (${file.size} bytes)`);

const problems = [];

for (const [name, target] of Object.entries(pkg.bin)) {
	const path = target.replace(/^\.\//, "");
	const entry = byPath.get(path);

	if (!entry) {
		problems.push(`bin "${name}" -> ${path} is missing — did the build run?`);
		continue;
	}
	if (entry.size < MIN_BIN_BYTES) {
		problems.push(
			`bin "${name}" -> ${path} is only ${entry.size} bytes; the build looks truncated`,
		);
	}
	if (!(entry.mode & 0o111)) {
		problems.push(`bin "${name}" -> ${path} is not executable (mode ${entry.mode.toString(8)})`);
	}
}

// .env.example is intentionally shipped; a real .env never should be.
for (const path of byPath.keys()) {
	if (path === ".env" || (path.startsWith(".env.") && path !== ".env.example")) {
		problems.push(`${path} must not be published`);
	}
}

if (problems.length > 0) {
	console.error(`\npack verification failed (${problems.length}):`);
	for (const problem of problems) console.error(`  - ${problem}`);
	process.exit(1);
}

console.log("\npack verified");
