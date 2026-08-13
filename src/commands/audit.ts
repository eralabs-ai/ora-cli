import { AuditApiError, type AuditOutcome, performAudit } from "../api/audit";
import { toReport } from "../report/model";
import { renderReport } from "../report/terminal";
import { isLocalTarget, openTunnel, type Tunnel } from "../tunnel";
import { spinner } from "../ui/spinner";

export interface AuditCommandInput {
	url: string;
	json: boolean;
	showSkipped: boolean;
	showPassing: boolean;
	/** Raw --min-score value; validated here so a bad value is a usage error. */
	minScore?: string;
	/** Raw --max-age value in seconds. */
	maxAge?: string;
	force: boolean;
	/** User-supplied command that exposes the target and prints a public https URL. */
	tunnelCmd?: string;
}

/**
 * The documented exit-code contract (README + --help):
 *   0 success (and score >= --min-score when given)
 *   1 score below --min-score
 *   2 usage error (bad flags, malformed URL, local target without a tunnel)
 *   3 API unreachable / timeout / rate limit exhausted
 */
export const EXIT = { OK: 0, BELOW_MIN_SCORE: 1, USAGE: 2, API: 3 } as const;

function parseIntFlag(
	raw: string | undefined,
	flag: string,
	min: number,
	max: number,
): { value?: number; error?: string } {
	if (raw === undefined) return {};
	const value = Number(raw);
	// Number("") is 0, so an empty value (e.g. an unset CI variable expanding
	// to "") would silently become a gate of 0 - reject it as a usage error.
	if (raw.trim() === "" || !Number.isInteger(value) || value < min || value > max) {
		return {
			error: `${flag} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw)}`,
		};
	}
	return { value };
}

/** Accepts bare domains and full URLs; rejects anything the API would 400 on sight. */
function normalizeTarget(raw: string): string | undefined {
	const target = raw.trim().replace(/\/+$/, "");
	if (!target || /\s/.test(target)) return undefined;
	try {
		const url = new URL(target.includes("://") ? target : `https://${target}`);
		if (!url.hostname.includes(".") && url.hostname !== "localhost") return undefined;
		return target;
	} catch {
		return undefined;
	}
}

export async function auditCommand(input: AuditCommandInput): Promise<number> {
	const target = normalizeTarget(input.url);
	if (!target) {
		console.error(`Not a scannable URL or domain: ${JSON.stringify(input.url)}`);
		return EXIT.USAGE;
	}
	const minScore = parseIntFlag(input.minScore, "--min-score", 0, 100);
	const maxAge = parseIntFlag(input.maxAge, "--max-age", 0, 86_400);
	for (const flag of [minScore, maxAge]) {
		if (flag.error) {
			console.error(flag.error);
			return EXIT.USAGE;
		}
	}

	// A local target only exists on this machine, so ora can never reach it
	// directly. The CLI ships no tunnel vendor of its own: the user supplies
	// the command (--tunnel-cmd / ORA_TUNNEL_CMD) and the result is stored as
	// ephemeral so the throwaway hostname never pollutes rankings.
	const tunnelCmd = input.tunnelCmd?.trim() || process.env.ORA_TUNNEL_CMD?.trim();
	const useTunnel = Boolean(tunnelCmd);
	if (!useTunnel && isLocalTarget(target)) {
		console.error(
			[
				`${target} only exists on this machine, and ora audits public URLs.`,
				"Either audit a publicly reachable deployment of this site (e.g. a preview URL),",
				"or run it through a tunnel you provide:",
				"  ax audit localhost:3000 --tunnel-cmd 'ngrok http 3000 --log stdout'",
				"Any command that prints a public https URL works; the result is stored as",
				"ephemeral (excluded from rankings, deleted after a few days).",
			].join("\n"),
		);
		return EXIT.USAGE;
	}

	const interactive = !input.json;
	if (interactive) spinner.start(`Auditing ${target} with ora`);
	let tunnel: Tunnel | undefined;
	const closeTunnel = () => tunnel?.close();
	const onSignal = (signal: NodeJS.Signals) => {
		closeTunnel();
		process.exit(signal === "SIGINT" ? 130 : 143);
	};
	let auditTarget = target;
	if (useTunnel && tunnelCmd) {
		if (interactive) spinner.update(`Opening a tunnel to ${target}`);
		try {
			tunnel = await openTunnel(tunnelCmd);
		} catch (cause) {
			spinner.stop();
			console.error(cause instanceof Error ? cause.message : String(cause));
			return EXIT.USAGE;
		}
		// The tunnel must not outlive an interrupted run. Installing a signal
		// listener removes Node's default exit, so after cleanup the handler
		// must terminate the process itself (conventional 128 + signal codes).
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);
		auditTarget = tunnel.url;
	}

	let outcome: AuditOutcome;
	try {
		outcome = await performAudit(auditTarget, {
			progress: interactive ? (line) => spinner.update(line) : undefined,
			maxAgeSeconds: maxAge.value,
			force: input.force,
			ephemeral: useTunnel || undefined,
		});
	} catch (cause) {
		spinner.stop();
		console.error(`Audit failed: ${cause instanceof Error ? cause.message : String(cause)}`);
		return cause instanceof AuditApiError ? EXIT.API : EXIT.USAGE;
	} finally {
		closeTunnel();
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
	}
	spinner.stop();

	const { result } = outcome;
	if (input.json) {
		// Raw contract passthrough: the payload exactly as ora served it.
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		for (const line of renderReport(toReport(outcome, target), {
			showSkipped: input.showSkipped,
			showPassing: input.showPassing,
			tunnel: useTunnel,
		})) {
			console.log(line);
		}
	}

	if (minScore.value !== undefined) {
		if (result.mcpAuthRequired) {
			// Documented contract guidance: an auth-gated MCP scan is unscored -
			// its 0/F means "could not evaluate", so a gate must not fail on it.
			process.stderr.write(
				"--min-score skipped: the MCP handshake requires credentials, so the target is unscored\n",
			);
			return EXIT.OK;
		}
		if (result.score < minScore.value) {
			if (!input.json) {
				console.log(`  Score ${result.score} is below the required minimum ${minScore.value}\n`);
			}
			return EXIT.BELOW_MIN_SCORE;
		}
	}
	return EXIT.OK;
}
