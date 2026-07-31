/**
 * Background-work registry — shared protocol for "not done yet" signals.
 *
 * Pi's `agent_settled` event only covers Pi's own automatic continuations
 * (retries, compaction retries, queued follow-ups). Work scheduled by an
 * extension — like this package's timers and heartbeats — wakes the agent
 * later via `pi.sendMessage({ triggerTurn: true })` and is invisible to Pi
 * core, so a completion notifier hooking `agent_settled` can still fire
 * prematurely.
 *
 * Extensions that schedule such work advertise it through a shared registry:
 * acquire a token when scheduling, release it when the work completes or is
 * cancelled. Completion notifiers (e.g. the pi `notify` example extension)
 * defer their notification while `pending() > 0`.
 *
 * The registry lives on `globalThis` behind `Symbol.for()`. Pi's extension
 * loader gives each extension its own module cache, so a module-level
 * singleton in a shared file would NOT be shared — but `Symbol.for()` keys
 * are process-global by spec, so every extension that touches this key gets
 * the same registry. The protocol is the key plus the token shape, not this
 * module: any extension can participate by implementing the same ~50 lines
 * against the same key, with no dependency on this package.
 */

const REGISTRY_KEY = Symbol.for("pi:background-work");

export interface BackgroundWorkRegistry {
	/** Number of background tasks currently advertised as pending. */
	pending(): number;
	/**
	 * Advertise a pending background task. Returns a release function; call it
	 * exactly once when the task completes or is cancelled. Safe to call more
	 * than once (subsequent calls are no-ops).
	 */
	acquire(source: string): () => void;
	/**
	 * Subscribe to the registry reaching zero pending tasks. Returns an
	 * unsubscribe function. Not called while tasks remain pending.
	 */
	onDrain(listener: () => void): () => void;
}

export function getBackgroundWorkRegistry(): BackgroundWorkRegistry {
	const g = globalThis as unknown as Record<symbol, BackgroundWorkRegistry | undefined>;
	let registry = g[REGISTRY_KEY];
	if (!registry) {
		const tasks = new Map<number, string>();
		const drainListeners = new Set<() => void>();
		let nextId = 0;
		registry = {
			pending: () => tasks.size,
			acquire(source: string) {
				const id = ++nextId;
				tasks.set(id, source);
				let released = false;
				return () => {
					if (released) return;
					released = true;
					if (!tasks.delete(id)) return;
					if (tasks.size === 0) {
						for (const listener of [...drainListeners]) listener();
					}
				};
			},
			onDrain(listener: () => void) {
				drainListeners.add(listener);
				return () => {
					drainListeners.delete(listener);
				};
			},
		};
		g[REGISTRY_KEY] = registry;
	}
	return registry;
}

/**
 * Advertise pending background work. Call the returned release function when
 * the work completes or is cancelled.
 */
export function acquireBackgroundWork(source: string): () => void {
	return getBackgroundWorkRegistry().acquire(source);
}
