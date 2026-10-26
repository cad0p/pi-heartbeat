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
}

type OutgoingMessage = {
	customType: string;
	content: string;
	display: boolean;
	details: Record<string, unknown>;
};

type Deliver = (message: OutgoingMessage) => boolean;

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
}

/**
 * Cross-version contract: written by one release, read by the next. Fields may
 * only be added. Readers accept the current version (and N-1 once a v2 exists);
 * any other version is disposed and replaced.
 */
interface SessionEntry {
	version: 1;
	timers: Map<string, ArmedTimer>;
	timerCounter: number;
	heartbeat?: ArmedHeartbeat;
	heartbeatIdCounter: number;
	/** Set while attached to a live activation; unset while detached (reload gap). */
	deliver?: Deliver;
	pending: QueuedMessage[];
	detachTimer?: NodeJS.Timeout;
	dispose(): void;
}

const SESSIONS = Symbol.for("pi-heartbeat.sessions");
/** How long a detached entry waits for the reloaded activation before it is retired. */
const DETACH_GRACE_MS = 5 * 60_000;

function registry(): Map<string, SessionEntry> {
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
	entry.pending.push(item);
}

function flush(entry: SessionEntry): void {
	while (entry.deliver && entry.pending.length > 0) {
		const next = entry.pending.shift();
		if (next) {
			send(entry, next);
		}
	}
}

/** Adopt the entry on a reload (flush deferred so no run starts inside the reload); otherwise replace it. */
function attach(key: string, reason: string, deliver: Deliver): SessionEntry {
	const sessions = registry();
	const existing = sessions.get(key);
	if (existing?.version === 1 && reason === "reload") {
		clearTimeout(existing.detachTimer);
		existing.deliver = deliver;
		setTimeout(() => flush(existing), 0);
		return existing;
	}
	existing?.dispose();
	const entry = createEntry();
	entry.deliver = deliver;
	sessions.set(key, entry);
	return entry;
}

function retire(entry: SessionEntry): void {
	entry.dispose();
	const sessions = registry();
	for (const [key, value] of sessions) {
		if (value === entry) {
			sessions.delete(key);
		}
	}
}

export class TimerManager {
	private session: SessionEntry;
	private readonly deliverNow: Deliver;

	/** Starts on a standalone entry; `bind` moves it onto the session registry at session_start. */
	constructor(pi: ExtensionAPI) {
		this.deliverNow = (message) => deliverVia(pi, message);
		this.session = createEntry();
		this.session.deliver = this.deliverNow;
	}

	// ── Session lifecycle ───────────────────────────────────────────

	bind(key: string, reason: string): void {
		this.session.dispose();
		this.session = attach(key, reason, this.deliverNow);
	}

	/** session_shutdown{reload}: stop delivering; the reloaded activation adopts the armed state. */
	detach(): void {
		const entry = this.session;
		entry.deliver = undefined;
		clearTimeout(entry.detachTimer);
		entry.detachTimer = setTimeout(() => retire(entry), DETACH_GRACE_MS);
	}

	/** session_shutdown (any other reason): tear the session's armed state down. */
	end(): void {
		retire(this.session);
	}

	// ── One-shot timers ─────────────────────────────────────────────

	setTimer(seconds: number, message: string, id?: string): string {
		const entry = this.session;
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
