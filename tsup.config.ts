import { defineConfig } from "tsup";

// One self-contained CJS executable: citty and picocolors are bundled in
// (noExternal), so `npx @ora-ai/ax` has zero install friction.
export default defineConfig({
	entry: { main: "src/main.ts" },
	format: ["cjs"],
	dts: false,
	splitting: false,
	sourcemap: false,
	banner: { js: "#!/usr/bin/env node" },
	noExternal: [/.*/],
	platform: "node",
	esbuildOptions(options) {
		options.minify = true;
	},
});
