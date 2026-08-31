import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CdpError, discoverEndpoint, normalizeHeaders } from "./cdp";

describe("normalizeHeaders", () => {
	it("re-joins CDP's newline-collapsed duplicates the way ora's capture does", () => {
		// Chrome hands repeated response headers back as one newline-joined
		// value; Playwright keeps them apart and ora rejoins with ", ". The
		// origin-trial parser splits on ",", so getting this wrong turns two
		// valid tokens into one unparseable one and can report a page with a
		// live WebMCP trial as having none.
		expect(normalizeHeaders({ "Origin-Trial": "tokenA\ntokenB" })).toEqual({
			"origin-trial": "tokenA, tokenB",
		});
	});

	it("lowercases names so header lookups match ora's", () => {
		expect(normalizeHeaders({ "Permissions-Policy": "model-context=*" })).toEqual({
			"permissions-policy": "model-context=*",
		});
	});

	it("drops the empty segments a trailing newline leaves behind", () => {
		expect(normalizeHeaders({ "origin-trial": "tokenA\n\n  \n" })).toEqual({
			"origin-trial": "tokenA",
		});
	});

	it("merges names that differ only in case rather than losing one", () => {
		expect(normalizeHeaders({ "Origin-Trial": "a", "origin-trial": "b" })).toEqual({
			"origin-trial": "a, b",
		});
	});
});

describe("discoverEndpoint", () => {
	let server: Server;
	let port: number;

	beforeAll(async () => {
		server = createServer((req, res) => {
			if (req.url === "/json/version") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						Browser: "Chrome/151.0.7922.174",
						webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/abc",
					}),
				);
				return;
			}
			if (req.url === "/empty/json/version") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ Browser: "Chrome/151" }));
				return;
			}
			res.writeHead(404).end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		port = (server.address() as { port: number }).port;
	});

	afterAll(async () => {
		await new Promise((resolve) => server.close(resolve));
	});

	it("takes a bare host:port and reads the version document", async () => {
		const endpoint = await discoverEndpoint(`127.0.0.1:${port}`);
		expect(endpoint.webSocketDebuggerUrl).toBe("ws://127.0.0.1:1/devtools/browser/abc");
		expect(endpoint.product).toBe("Chrome/151.0.7922.174");
	});

	it("takes an http origin, trailing slashes and all", async () => {
		const endpoint = await discoverEndpoint(`http://127.0.0.1:${port}//`);
		expect(endpoint.product).toBe("Chrome/151.0.7922.174");
	});

	it("passes a ws:// endpoint straight through without probing", async () => {
		// Nothing is listening on port 1; a ws:// target names the socket
		// itself, so no HTTP probe should be attempted. The product is filled
		// in later from Browser.getVersion.
		const endpoint = await discoverEndpoint("ws://127.0.0.1:1/devtools/browser/xyz");
		expect(endpoint).toEqual({
			webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/xyz",
			product: "",
		});
	});

	it("reports a CdpError naming the origin when nothing answers", async () => {
		await expect(discoverEndpoint("127.0.0.1:1", 250)).rejects.toBeInstanceOf(CdpError);
	});

	it("refuses a version document with no debugger URL", async () => {
		// A 200 that carries no socket is not a debuggable Chrome, and treating
		// it as one would fail later with a much less obvious message.
		await expect(discoverEndpoint(`http://127.0.0.1:${port}/empty`)).rejects.toThrow(
			/webSocketDebuggerUrl/,
		);
	});
});
