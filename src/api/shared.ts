// Plumbing shared by both API clients. Note that the two ora streams do NOT
// share an SSE parser: the scan stream is data-only JSON with a `type` field,
// while the run stream uses named `event:` blocks with `: ping` heartbeats.
// Each client owns its own decoder; only the timeout/error plumbing lives here.

/**
 * Idle watchdog for a long-lived stream: aborts the fetch when `poke()` hasn't
 * been called for `ms`. Unlike a fixed deadline, a stream that keeps emitting
 * can run indefinitely — which is what a slow-but-healthy scan or agent needs.
 */
export function watchdog(ms: number): {
	signal: AbortSignal;
	poke: () => void;
	disarm: () => void;
	tripped: () => boolean;
} {
	const controller = new AbortController();
	let fired = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const poke = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			fired = true;
			controller.abort();
		}, ms);
	};
	poke();
	return {
		signal: controller.signal,
		poke,
		disarm: () => clearTimeout(timer),
		tripped: () => fired,
	};
}

/** Best-effort human message from an error response body. */
export async function errorBodyText(res: Response): Promise<string> {
	try {
		const payload = (await res.json()) as { message?: string; error?: string };
		return payload.message || payload.error || `HTTP ${res.status}`;
	} catch {
		return `HTTP ${res.status}`;
	}
}

export const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
