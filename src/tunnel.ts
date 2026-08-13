import { spawn } from "node:child_process";

// Vendor-neutral tunnel plumbing for auditing a local dev server: run the
// user-supplied tunnel command (--tunnel-cmd / ORA_TUNNEL_CMD), scan its
// output for the public https URL it prints, audit that, tear it down.
// The CLI deliberately ships no tunnel vendor of its own and never downloads
// executables at runtime (trust posture): whatever tunnel tool the user
// already has works, as long as it prints its public URL to stdout or stderr
// (e.g. `ngrok http 3000 --log stdout`).

/** Tunnel setup failure - a usage-class error (exit 2), never an API error. */
export class TunnelError extends Error {}

export interface Tunnel {
	/** The public https origin the tunnel command printed. */
	url: string;
	close: () => void;
}

const TUNNEL_READY_MS = 30_000;
// Separate, larger budget for the first end-to-end response: the probe path
// crosses the tunnel vendor's edge AND the local server's cold start (a dev
// server's first compile alone can eat 20s), so probes are patient.
const TUNNEL_ROUTABLE_MS = 90_000;
const PROBE_TIMEOUT_MS = 10_000;

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

/**
 * The public origin a tunnel command prints. Accepts only bare https origins
 * (no path, no query) on a non-local host: that is the shape of every
 * vendor's forwarding URL, and NOT the shape of the docs/error links
 * (https://vendor.example/docs/...) a misconfigured command prints on its way
 * out - those must never be mistaken for a tunnel.
 */
export function findPublicUrl(output: string): string | undefined {
	for (const match of output.matchAll(/https:\/\/[^\s"'|]+/g)) {
		try {
			const url = new URL(match[0]);
			if (url.pathname === "/" && !url.search && !isLocalTarget(url.hostname)) {
				return url.origin;
			}
		} catch {
			// not a parseable URL - keep scanning
		}
	}
	return undefined;
}

/**
 * Run `command` (through the shell), wait for the public URL it prints AND
 * for the edge to actually route it (vendors print the banner seconds before
 * the tunnel serves traffic - auditing immediately reads as "domain not
 * reachable"). The caller owns the returned handle: close() on every exit
 * path.
 */
export async function openTunnel(command: string, readyMs = TUNNEL_READY_MS): Promise<Tunnel> {
	const tunnel = await spawnTunnelCommand(command, readyMs);
	try {
		await waitRoutable(tunnel.url, TUNNEL_ROUTABLE_MS);
	} catch (cause) {
		tunnel.close();
		throw cause;
	}
	return tunnel;
}

// Vendors' edges answer 5xx until the tunnel connects; once traffic flows,
// the status is whatever the local server returns. Probes are spaced 5s
// apart: a fresh tunnel DNS record takes seconds to exist, and hammering it
// early primes the resolver's negative cache, which then outlives the
// propagation delay.
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
			"Some networks and DNS filters block tunnel vendors' domains entirely -",
			"if this repeats, try another network, DNS resolver, or tunnel tool.",
		].join("\n"),
	);
}

function spawnTunnelCommand(command: string, readyMs: number): Promise<Tunnel> {
	return new Promise<Tunnel>((resolve, reject) => {
		// shell: the command is the user's own one-liner, flags and all.
		// detached (POSIX): the shell wrapper dies on kill() but the tunnel
		// process it spawned would survive - signal the whole process group.
		const posix = process.platform !== "win32";
		const child = spawn(command, {
			shell: true,
			detached: posix,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let settled = false;
		// Rolling tail of combined output: enough to catch a URL split across
		// chunks and to quote back when the command dies without printing one.
		let tail = "";
		const close = () => {
			try {
				if (posix && child.pid) process.kill(-child.pid, "SIGTERM");
				else child.kill("SIGTERM");
			} catch {
				// already gone
			}
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
						`tunnel command did not print a public https URL within ${Math.round(readyMs / 1000)}s: ${command}`,
					),
				),
			readyMs,
		);

		child.on("error", (cause: Error) => fail(new TunnelError(cause.message)));
		child.on("exit", (code) => {
			const quoted = tail.trim() ? `\noutput: ${tail.trim().slice(-300)}` : "";
			fail(
				new TunnelError(
					`tunnel command exited before printing a public https URL (code ${code ?? "unknown"}): ${command}${quoted}`,
				),
			);
		});

		for (const stream of [child.stdout, child.stderr]) {
			stream?.setEncoding("utf8");
			stream?.on("data", (chunk: string) => {
				tail = (tail + chunk).slice(-2000);
				const url = findPublicUrl(tail);
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
