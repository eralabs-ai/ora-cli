import { spawn } from "node:child_process";

// Quick tunnel plumbing for auditing a local dev server: spawn a PREINSTALLED
// cloudflared, parse the throwaway trycloudflare.com URL it mints, audit that,
// tear it down. The binary is required rather than downloaded on demand -
// this CLI is a trust artifact and will not fetch executables at runtime
// (supply-chain posture); a missing binary is a usage error with install hints.

/** Tunnel setup failure - a usage-class error (exit 2), never an API error. */
export class TunnelError extends Error {}

export interface Tunnel {
	/** The public https://<random>.trycloudflare.com origin. */
	url: string;
	close: () => void;
}

const TUNNEL_READY_MS = 30_000;
// Separate, larger budget for the first end-to-end response: the probe path
// crosses the Cloudflare edge AND the local server's cold start (a dev
// server's first compile alone can eat 20s), so probes are patient.
const TUNNEL_ROUTABLE_MS = 90_000;
const PROBE_TIMEOUT_MS = 10_000;

export const CLOUDFLARED_INSTALL_HINT = [
	"cloudflared is required for --tunnel and is not installed (or not on PATH).",
	"Install it, then re-run:",
	"  macOS    brew install cloudflared",
	"  Linux    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
	"  Windows  winget install Cloudflare.cloudflared",
].join("\n");

/** Loopback / mDNS / *.localhost targets that only exist on this machine. */
export function isLocalTarget(target: string): boolean {
	try {
		const url = new URL(target.includes("://") ? target : `http://${target}`);
		const host = url.hostname;
		return (
			host === "localhost" ||
			host === "127.0.0.1" ||
			host === "::1" ||
			host === "[::1]" ||
			host.endsWith(".local") ||
			host.endsWith(".localhost")
		);
	} catch {
		return false;
	}
}

/** The quick-tunnel URL cloudflared prints (to stderr) once it is connected. */
export function findTunnelUrl(line: string): string | undefined {
	return line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
}

/**
 * Spawn `cloudflared tunnel --url <target>`, wait for its public URL AND for
 * the edge to actually route it (the banner prints seconds before the tunnel
 * serves traffic - auditing immediately reads as "domain not reachable").
 * The caller owns the returned handle: close() on every exit path.
 */
export async function openTunnel(target: string, readyMs = TUNNEL_READY_MS): Promise<Tunnel> {
	const tunnel = await spawnQuickTunnel(target, readyMs);
	try {
		await waitRoutable(tunnel.url, TUNNEL_ROUTABLE_MS);
	} catch (cause) {
		tunnel.close();
		throw cause;
	}
	return tunnel;
}

// The cloudflare edge answers 530 (error 1033) until the tunnel connects;
// once traffic flows, the status is whatever the local server returns. Probes
// are spaced 5s apart: the quick-tunnel DNS record takes seconds to exist,
// and hammering it early primes the resolver's negative cache, which then
// outlives the propagation delay.
async function waitRoutable(url: string, routableMs: number): Promise<void> {
	const deadline = Date.now() + routableMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, {
				redirect: "manual",
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			});
			if (res.status < 500) return;
		} catch {
			// DNS not propagated yet, or the probe timed out - keep waiting
		}
		await new Promise((r) => setTimeout(r, 5000));
	}
	throw new TunnelError(
		[
			`tunnel opened but never became routable within ${Math.round(routableMs / 1000)}s.`,
			"Some networks and DNS filters block *.trycloudflare.com entirely -",
			"if this repeats, try another network or DNS resolver (e.g. 1.1.1.1).",
		].join("\n"),
	);
}

function spawnQuickTunnel(target: string, readyMs: number): Promise<Tunnel> {
	const origin = target.includes("://") ? target : `http://${target}`;

	return new Promise<Tunnel>((resolve, reject) => {
		// http2, not the default quic: quic needs UDP 7844 out, which corporate
		// and hotel networks routinely block, and cloudflared does not reliably
		// fall back on its own - the tunnel registers, prints its URL, then never
		// serves. http2 rides TCP 443 and works everywhere; for a short-lived
		// audit tunnel the throughput difference is irrelevant.
		const child = spawn("cloudflared", ["tunnel", "--protocol", "http2", "--url", origin], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let settled = false;
		const close = () => {
			child.kill("SIGTERM");
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			close();
			reject(error);
		};
		const deadline = setTimeout(
			() =>
				fail(
					new TunnelError(
						`cloudflared did not report a tunnel URL within ${Math.round(readyMs / 1000)}s`,
					),
				),
			readyMs,
		);

		child.on("error", (cause: NodeJS.ErrnoException) => {
			fail(new TunnelError(cause.code === "ENOENT" ? CLOUDFLARED_INSTALL_HINT : cause.message));
		});
		child.on("exit", (code) => {
			fail(new TunnelError(`cloudflared exited early (code ${code ?? "unknown"})`));
		});

		// cloudflared logs to stderr; scan both to be version-proof.
		for (const stream of [child.stdout, child.stderr]) {
			stream?.setEncoding("utf8");
			stream?.on("data", (chunk: string) => {
				const url = findTunnelUrl(chunk);
				if (url && !settled) {
					settled = true;
					clearTimeout(deadline);
					child.removeAllListeners("exit");
					resolve({ url, close });
				}
			});
		}
	});
}
