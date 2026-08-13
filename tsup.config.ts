import { defineConfig } from "tsup";

export default defineConfig([
	// The bin: one self-contained CJS executable. citty and picocolors are
	// bundled in (noExternal), so `npx @ora-ai/ax` has zero install friction.
	{
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
	},
	// The library: `import { audit } from "@ora-ai/ax"` - esm + cjs, unminified,
	// no shebang. It has no runtime dependencies (picocolors and citty are
	// CLI-only), so nothing needs bundling here. Declarations come from
	// `tsc -p tsconfig.lib.json` in the build script: tsup's dts step needs the
	// TypeScript compiler API, which TypeScript 7 (native port) does not expose.
	{
		entry: { index: "src/index.ts" },
		format: ["esm", "cjs"],
		dts: false,
		splitting: false,
		sourcemap: false,
		platform: "node",
	},
]);
