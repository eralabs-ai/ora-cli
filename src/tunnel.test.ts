import { afterEach, describe, expect, it, vi } from "vitest";
import { findPublicUrl, isLocalTarget, openTunnel, TunnelError } from "./tunnel";

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

describe("findPublicUrl", () => {
	it("extracts the bare https origin a tunnel command prints", () => {
		// ngrok --log stdout announces the forwarding URL as url=...
		expect(
			findPublicUrl(
				't=2026-08-13 lvl=info msg="started tunnel" addr=http://localhost:3000 url=https://d5ab-203-0-113-7.ngrok-free.app',
			),
		).toBe("https://d5ab-203-0-113-7.ngrok-free.app");
		// banner style: URL boxed in whitespace and pipes
		expect(findPublicUrl("INF |  https://tacit-rumors-lately.example-tunnel.dev  |")).toBe(
			"https://tacit-rumors-lately.example-tunnel.dev",
		);
	});

	it("never mistakes docs/error links or local URLs for the tunnel", () => {
		// A misconfigured vendor exits with a docs link - it has a path.
		expect(
			findPublicUrl("ERROR: authentication failed: https://ngrok.example/docs/errors/err_105"),
		).toBeUndefined();
		expect(findPublicUrl("web interface at https://localhost:4040")).toBeUndefined();
		expect(findPublicUrl("plain http://insecure.example.com")).toBeUndefined();
		expect(findPublicUrl("no url here")).toBeUndefined();
	});

	it("skips non-origin URLs and returns the first qualifying one", () => {
		const output = [
			"read the guide: https://vendor.example/setup/quickstart",
			"forwarding https://abc123.tunnel.example",
		].join("\n");
		expect(findPublicUrl(output)).toBe("https://abc123.tunnel.example");
	});
});

describe("openTunnel", () => {
	afterEach(() => vi.unstubAllGlobals());

	// 20s budget: the routability loop deliberately waits 5s between probes.
	it("resolves once the URL is printed AND the edge routes it", { timeout: 20_000 }, async () => {
		// A stand-in tunnel command that behaves like a real one: banner on
		// stderr, then stays alive until killed.
		const command = 'echo "INF |  https://fake-quick.tunnel.example  |" >&2; sleep 30';

		// The vendor edge answers 5xx until the tunnel connects; then traffic flows.
		const probes: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				probes.push(String(url));
				return new Response("ok", { status: probes.length === 1 ? 530 : 200 });
			}),
		);
		const tunnel = await openTunnel(command, 15_000);
		expect(tunnel.url).toBe("https://fake-quick.tunnel.example");
		expect(probes.length).toBeGreaterThanOrEqual(2);
		tunnel.close();
	});

	it("is a TunnelError quoting the output when the command exits without a URL", async () => {
		await expect(openTunnel("echo 'authtoken missing'; exit 3", 5000)).rejects.toThrow(TunnelError);
		await expect(openTunnel("echo 'authtoken missing'; exit 3", 5000)).rejects.toThrow(
			/exited before printing a public https URL[\s\S]*authtoken missing/,
		);
	});

	it("is a TunnelError when the command does not exist", async () => {
		await expect(
			openTunnel("definitely-not-a-real-tunnel-binary-xyz http 3000", 5000),
		).rejects.toThrow(TunnelError);
	});
});
