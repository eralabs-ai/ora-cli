import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findTunnelUrl, isLocalTarget, openTunnel, TunnelError } from "./tunnel";

describe("isLocalTarget", () => {
	it("spots loopback, mDNS, and *.localhost targets, with or without a scheme", () => {
		for (const target of [
			"localhost",
			"localhost:3000",
			"http://localhost:3000",
			"127.0.0.1:8080",
			"my-app.local",
			"http://fix-ui.ora.localhost:1355",
		]) {
			expect(isLocalTarget(target), target).toBe(true);
		}
	});

	it("leaves public targets alone", () => {
		for (const target of ["example.com", "https://docs.stripe.com", "192.168.1.50:3000"]) {
			expect(isLocalTarget(target), target).toBe(false);
		}
	});
});

describe("findTunnelUrl", () => {
	it("extracts the quick-tunnel URL from cloudflared's banner line", () => {
		const banner =
			"2026-08-13T10:00:00Z INF |  https://tacit-rumors-lately-manner.trycloudflare.com  |";
		expect(findTunnelUrl(banner)).toBe("https://tacit-rumors-lately-manner.trycloudflare.com");
		expect(findTunnelUrl("no url here")).toBeUndefined();
	});
});

describe("openTunnel", () => {
	const originalPath = process.env.PATH;
	afterEach(() => {
		process.env.PATH = originalPath;
	});

	it("is a TunnelError with install hints when cloudflared is absent", async () => {
		process.env.PATH = mkdtempSync(join(tmpdir(), "ax-empty-path-"));
		await expect(openTunnel("localhost:3000", 5000)).rejects.toThrow(TunnelError);
		process.env.PATH = mkdtempSync(join(tmpdir(), "ax-empty-path-"));
		await expect(openTunnel("localhost:3000", 5000)).rejects.toThrow(/brew install cloudflared/);
	});

	// 20s budget: the routability loop deliberately waits 5s between probes.
	it("resolves once the URL is printed AND the edge routes it", { timeout: 20_000 }, async () => {
		// A stand-in cloudflared that behaves like the real one: banner on
		// stderr, then stays alive until killed.
		const dir = mkdtempSync(join(tmpdir(), "ax-fake-cloudflared-"));
		const fake = join(dir, "cloudflared");
		writeFileSync(
			fake,
			'#!/bin/sh\necho "INF |  https://fake-quick-tunnel.trycloudflare.com  |" >&2\nsleep 30\n',
		);
		chmodSync(fake, 0o755);
		process.env.PATH = `${dir}:${originalPath}`;

		// The edge answers 530 until the tunnel connects; then traffic flows.
		const probes: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				probes.push(String(url));
				return new Response("ok", { status: probes.length === 1 ? 530 : 200 });
			}),
		);
		try {
			const tunnel = await openTunnel("localhost:3000", 15_000);
			expect(tunnel.url).toBe("https://fake-quick-tunnel.trycloudflare.com");
			expect(probes.length).toBeGreaterThanOrEqual(2);
			tunnel.close();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
