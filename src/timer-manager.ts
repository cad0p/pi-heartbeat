/**
 * TimerManager — one-shot timers and heartbeats, bound to a pi session.
 *
 * Armed state lives in a per-session entry kept in a process-global registry,
 * so it survives `/reload`: the old activation detaches its delivery on
 * session_shutdown, the new one adopts the entry on session_start and flushes
 * whatever fired in between. Messages fire via pi.sendMessage({ triggerTurn: true }).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ActiveTimer {
	id: string;
	seconds: number;
	message: string;
	createdAt: string;
}

export interface HeartbeatState {
	id: number;
	intervalSeconds: number;
	message: string;
	tick: number;
	createdAt: string;
	/**
	 * Wall-clock of the last tick. `tick` counts `setInterval` callbacks, and Node coalesces the
	 * ones it misses during a stall, so `tick` lags real time forever after one. Optional: an entry
	 * written before this field existed has none, and readers fall back.
	 */
	lastTickAt?: string;
}

type OutgoingMessage = {
	customType: string;
	content: string;
	display: boolean;
	details: Record<string, unknown>;
};

type Deliver = (message: OutgoingMessage) => boolean;

/** `seconds`, `message`, `createdAt` and `deadline` are written but not read yet: kept for the cross-version contract and restart persistence (#7). */
interface ArmedTimer {
	timeout: NodeJS.Timeout;
	seconds: number;
	message: string;
	createdAt: string;
	deadline: number;
}

interface ArmedHeartbeat {
	interval: NodeJS.Timeout;
	state: HeartbeatState;
}

interface QueuedMessage {
	heartbeatId?: number;
	message: OutgoingMessage;
	/** Stable per-entry sequence, assigned when queued while detached (background-work ids). */
	seq?: number;
}

/**
 * Cross-version contract: written by one release, read by the next. Fields may
 * only be added. Readers accept the current version (and N-1 once a v2 exists);
 * any other version is disposed and replaced.
 */
export interface SessionEntry {
	version: 1;
	timers: Map<string, ArmedTimer>;
	timerCounter: number;
	heartbeat?: ArmedHeartbeat;
	heartbeatIdCounter: number;
	/** Set while attached to a live activation; unset while detached (reload gap). */
	deliver?: Deliver;
	pending: QueuedMessage[];
	/** Last `seq` handed out to a queued message. */
	queueCounter?: number;
	detachTimer?: NodeJS.Timeout;
	dispose(): void;
}

const SESSIONS = Symbol.for("pi-heartbeat.sessions");
/** How long a detached entry waits for the reloaded activation before it is retired. */
const DETACH_GRACE_MS = 5 * 60_000;

/** Timer ids the `timer` tool accepts: 1-200 chars, no edge whitespace, no control characters. */
export const TIMER_ID_MAX_LENGTH = 200;
export const TIMER_ID_PATTERN = "^(?!\\s)(?![\\s\\S]*\\s$)[^\\x00-\\x1f\\x7f]+$";
/**
 * Longest id the background-work consumer can list: its v1 item ids are capped at 256 UTF-16 units, and the
 * item is `timer:<id>`. The tool's `maxLength` counts code points, so it cannot enforce this: 200 astral
 * characters are 400 units. An over-long id was accepted and armed, but the provider skipped it, so a record
 * waiting only on that timer looked idle and could settle.
 */
export const MAX_LISTABLE_TIMER_ID_LENGTH = 256 - "timer:".length;

export function registry(): Map<string, SessionEntry> {
	const host = globalThis as unknown as { [SESSIONS]?: Map<string, SessionEntry> };
	host[SESSIONS] ??= new Map();
	return host[SESSIONS];
}

function createEntry(): SessionEntry {
	const entry: SessionEntry = {
		version: 1,
		timers: new Map(),
		timerCounter: 0,
		heartbeatIdCounter: 0,
		pending: [],
		dispose: () => {
			clearArmed(entry);
			clearTimeout(entry.detachTimer);
			entry.deliver = undefined;
		},
	};
	return entry;
}

function haltHeartbeat(entry: SessionEntry): HeartbeatState | undefined {
	const armed = entry.heartbeat;
	if (!armed) {
		return undefined;
	}
	clearInterval(armed.interval);
	entry.heartbeat = undefined;
	entry.pending = entry.pending.filter((item) => item.heartbeatId !== armed.state.id);
	return armed.state;
}

function clearArmed(entry: SessionEntry): void {
	for (const timer of entry.timers.values()) {
		clearTimeout(timer.timeout);
	}
	entry.timers.clear();
	haltHeartbeat(entry);
	entry.pending = [];
}

function deliverVia(pi: ExtensionAPI, message: OutgoingMessage): boolean {
	try {
		pi.sendMessage(message, { triggerTurn: true });
		return true;
	} catch {
		// Stale ctx (session replaced or reloaded under us): sendMessage will never
		// succeed on this pi. Report it; the caller drops the message or stops the heartbeat.
		return false;
	}
}

function send(entry: SessionEntry, item: QueuedMessage): void {
	if (entry.deliver) {
		if (!entry.deliver(item.message) && item.heartbeatId !== undefined) {
			haltHeartbeat(entry);
		}
		return;
	}
	// Detached (reload gap): keep at most one queued tick per heartbeat.
	if (item.heartbeatId !== undefined) {
		entry.pending = entry.pending.filter((queued) => queued.heartbeatId !== item.heartbeatId);
	}
	entry.queueCounter = (entry.queueCounter ?? 0) + 1;
	entry.pending.push({ ...item, seq: entry.queueCounter });
}

function flush(entry: SessionEntry): void {
	while (entry.deliver && entry.pending.length > 0) {
		const next = entry.pending.shift();
		if (next) {
			send(entry, next);
		}
	}
}

/**
 * Adopt a detached entry on a reload (flush deferred so no run starts inside the reload). Otherwise a detached
 * entry is replaced, and a live one is left to its activation: this one runs standalone, off the registry.
 */
function attach(key: string, reason: string, deliver: Deliver): SessionEntry {
	const sessions = registry();
	const existing = sessions.get(key);
	if (existing?.version === 1 && existing.deliver === undefined && reason === "reload") {
		clearTimeout(existing.detachTimer);
		existing.deliver = deliver;
		setTimeout(() => flush(existing), 0);
		return existing;
	}
	const entry = createEntry();
	entry.deliver = deliver;
	if (existing?.deliver) {
		return entry;
	}
	existing?.dispose();
	sessions.set(key, entry);
	return entry;
}

/** Dispose an entry and drop its registry slot, if the slot still holds this entry (a standalone one never does). */
function retire(key: string | undefined, entry: SessionEntry): void {
	entry.dispose();
	if (key !== undefined && registry().get(key) === entry) {
		registry().delete(key);
	}
}

export class TimerManager {
	private session: SessionEntry;
	private sessionKey?: string;
	private readonly deliverNow: Deliver;

	/** Starts on a standalone entry; `bind` moves it onto the session registry at session_start. */
	constructor(pi: ExtensionAPI) {
		this.deliverNow = (message) => deliverVia(pi, message);
		this.session = createEntry();
		this.session.deliver = this.deliverNow;
	}

	// ── Session lifecycle ───────────────────────────────────────────

	/**
	 * Bind the manager to a session. Disposing the current entry first is safe only because pi emits
	 * `session_start` once per activation (1.4.0 and 0.84.1): a second `session_start{reason:"reload"}`
	 * on this manager would adopt the just-disposed entry and drop the armed timers.
	 */
	bind(key: string, reason: string): void {
		this.session.dispose();
		this.sessionKey = key;
		this.session = attach(key, reason, this.deliverNow);
	}

	/** session_shutdown{reload}: stop delivering; the reloaded activation adopts the armed state. */
	detach(): void {
		const entry = this.session;
		const key = this.sessionKey;
		entry.deliver = undefined;
		clearTimeout(entry.detachTimer);
		entry.detachTimer = setTimeout(() => retire(key, entry), DETACH_GRACE_MS).unref();
	}

	/** session_shutdown (any other reason): tear the session's armed state down. */
	end(): void {
		retire(this.sessionKey, this.session);
	}

	// ── One-shot timers ─────────────────────────────────────────────

	setTimer(seconds: number, message: string, id?: string): string {
		const entry = this.session;
		if (id !== undefined && id.length > MAX_LISTABLE_TIMER_ID_LENGTH) {
			throw new Error(
				`Timer id is ${id.length} UTF-16 units long; at most ${MAX_LISTABLE_TIMER_ID_LENGTH} are allowed, so the background-work item "timer:<id>" fits its 256-unit budget. The tool's 200-character limit counts code points, so an id of astral characters can pass it and still be refused here (each counts as two units).`,
			);
		}
		const timerId = id ?? `timer-${++entry.timerCounter}`;

		// Cancel existing timer with same ID
		this.cancelTimer(timerId);

		const timeout = setTimeout(() => {
			entry.timers.delete(timerId);
			send(entry, {
				message: {
					customType: "heartbeat-timer",
					content: `⏰ Timer [${timerId}] fired (after ${seconds}s): ${message}`,
					display: true,
					details: {
						type: "timer",
						timerId,
						seconds,
						message,
						firedAt: new Date().toISOString(),
					},
				},
			});
		}, seconds * 1000);

		entry.timers.set(timerId, {
			timeout,
			seconds,
			message,
			createdAt: new Date().toISOString(),
			deadline: Date.now() + seconds * 1000,
		});
		return timerId;
	}

	cancelTimer(id: string): boolean {
		const timer = this.session.timers.get(id);
		if (timer) {
			clearTimeout(timer.timeout);
			this.session.timers.delete(id);
			return true;
		}
		return false;
	}

	getActiveTimerIds(): string[] {
		return [...this.session.timers.keys()];
	}

	// ── Heartbeat (periodic) ────────────────────────────────────────

	startHeartbeat(intervalSeconds: number, message: string): HeartbeatState {
		const entry = this.session;
		this.stopHeartbeat();

		const state: HeartbeatState = {
			id: ++entry.heartbeatIdCounter,
			intervalSeconds,
			message,
			tick: 0,
			createdAt: new Date().toISOString(),
		};

		const interval = setInterval(() => {
			state.tick++;
			state.lastTickAt = new Date().toISOString();
			send(entry, {
				heartbeatId: state.id,
				message: {
					customType: "heartbeat-ping",
					content: `💓 Heartbeat #${state.id} tick ${state.tick} (every ${intervalSeconds}s): ${message}`,
					display: true,
					details: {
						type: "heartbeat",
						heartbeatId: state.id,
						tick: state.tick,
						intervalSeconds,
						message,
						firedAt: new Date().toISOString(),
					},
				},
			});
		}, intervalSeconds * 1000);

		entry.heartbeat = { interval, state };
		return { ...state };
	}

	stopHeartbeat(): HeartbeatState | undefined {
		return haltHeartbeat(this.session);
	}

	getHeartbeatState(): HeartbeatState | undefined {
		const state = this.session.heartbeat?.state;
		return state ? { ...state } : undefined;
	}

	isHeartbeatActive(): boolean {
		return this.session.heartbeat !== undefined;
	}

	// ── Cleanup ─────────────────────────────────────────────────────

	clearAll(): void {
		clearArmed(this.session);
	}
}
