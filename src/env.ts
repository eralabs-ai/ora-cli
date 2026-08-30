/**
 * Loads a local `.env` into the environment, if one is there.
 *
 * The CLI already promised this everywhere but never did it: `.env.example`
 * says "Copy to `.env` and fill in", the missing-key error points at "a local
 * .env file", and `.env.example` even ships inside the published tarball — yet
 * nothing ever read the file. Following those instructions produced
 * "Missing ORA_API_KEY".
 *
 * Uses Node's built-in loader rather than a dependency: the CLI ships as one
 * self-contained bundle with no runtime deps, and this keeps it that way.
 *
 * Reads only the current directory, matching what the docs describe and what
 * dotenv does by default. Exported variables win over the file, so a key set
 * for the shell or by CI beats a stale `.env` left in the directory.
 *
 * @returns whether a file was actually loaded.
 */
export function loadLocalEnv(): boolean {
	// Node gained loadEnvFile in 20.12. `engines` asks for that, but engines is
	// advisory — an older runtime should still start and fail later on the
	// missing key, not die here with a TypeError.
	if (typeof process.loadEnvFile !== "function") return false;

	try {
		process.loadEnvFile();
		return true;
	} catch {
		// No .env here. The common case: `npx ax audit` needs no config.
		return false;
	}
}
