import { describe, expect, it } from "vitest";
import { deriveIframeAllow } from "./capture";

// The cases below are ora's own, copied alongside the logic they cover. That is
// the point: this file is not checking that our implementation is reasonable, it
// is checking that it answers the way ora answers. A case that has to be
// softened to pass here is a divergence, not a bad test.

describe("deriveIframeAllow", () => {
	it("is null when the page says nothing about a model-context feature", () => {
		expect(deriveIframeAllow(null)).toBeNull();
		expect(deriveIframeAllow("geolocation=(), camera=(self)")).toBeNull();
	});

	it("is false when the feature is closed or kept to the page itself", () => {
		expect(deriveIframeAllow("model-context=()")).toBe(false);
		expect(deriveIframeAllow("model-context=(self)")).toBe(false);
		expect(deriveIframeAllow("camera=(), model-context=(self)")).toBe(false);
	});

	it("is true when the feature is delegated beyond the page", () => {
		expect(deriveIframeAllow("model-context=*")).toBe(true);
		expect(deriveIframeAllow('model-context=(self "https://embed.example.com")')).toBe(true);
		expect(deriveIframeAllow('modelcontext=("https://embed.example.com")')).toBe(true);
	});
});
