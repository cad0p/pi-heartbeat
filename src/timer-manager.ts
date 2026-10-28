/**
 * TimerManager — one-shot timers and heartbeats, bound to a pi session.
 *
 * Armed state lives in a per-session entry kept in a process-global registry,
 * so it survives `/reload`: the old activation detaches its delivery on
 * session_shutdown, the new one adopts the entry on session_start and flushes
 * whatever fired in between. Messages fire via pi.sendMessage({ triggerTurn: true }).
 *
 * Every action is also appended to the session as a custom entry (see session-state.ts), so a new
 * process replays it: what is still due re-arms, what came due while pi was not running wakes once.
 * A deliberate shutdown writes a `clear`, so only a crash leaves work to recover. Every write goes
 * through `entry.persist`, never a sink held at call time: a second copy's quit must not wipe the
 * log of the activation that owns the session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentOwner } from "./process-identity.js";
import {
	type ClearReason,
	HEARTBEAT_STATE_ENTRY,
	HEARTBEAT_STATE_VERSION,
	type HeartbeatStateData,
	type ReplayResult,
	type RestoredHeartbeat,
	type RestoredTimer,
	type TimerState,
	type TimerStateRecord,
} from "./session-state.js";

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

/**
 * One armed timer. Its only clock is `createdAt + seconds`, the sum the footer counts down and the one
 * a persisted record restores from, so a restart never extends a wait and nothing can diverge from it.
 */
interface ArmedTimer {
	timeout: NodeJS.Timeout;
	seconds: number;
	message: string;
	createdAt: string;
}

interface ArmedHeartbeat {
	/** The running interval, or the pending first-boundary timeout of a restored heartbeat. */
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
	/**
	 * Appends one record to this session. Unset while detached, and on an entry this activation does not
	 * own (a second copy on a live key): such an activation must not rewrite another one's log.
	 */
	persist?: (record: TimerStateRecord) => void;
	pending: QueuedMessage[];
	/** Last `seq` handed out to a queued message. */
	queueCounter?: number;
	detachTimer?: NodeJS.Timeout;
	dispose(): void;
}

const SESSIONS = Symbol.for("pi-heartbeat.sessions");
/** How long a detached entry waits for the reloaded activation before it is retired. */
const DETACH_GRACE_MS = 5 * 60_000;

/** Timer ids the `timer` tool accepts: 1-200 grapheme clusters, no edge whitespace, no control characters. */
export const TIMER_ID_MAX_LENGTH = 200;
export const TIMER_ID_PATTERN = "^(?!\\s)(?![\\s\\S]*\\s$)[^\\x00-\\x1f\\x7f]+$";
/**
 * Longest id the background-work consumer can list: its v1 item ids are capped at 256 UTF-16 units, and the
 * item is `timer:<id>`. The tool's `maxLength` counts grapheme clusters (typebox 1.x, which the host compiles
 * the schema with), so it cannot enforce this: 200 astral characters are 400 units. An over-long id was accepted
 * and armed, but the provider skipped it, so a record waiting only on that timer looked idle and could settle.
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
			entry.persist = undefined;
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

/**
 * Append one record through the entry's current sink. Every write goes through here, so a throw can
 * neither break arming or firing nor leave a half-written state in the caller.
 */
function writeRecord(entry: SessionEntry, record: TimerStateRecord): void {
	try {
		entry.persist?.(record);
	} catch {
		// A stale pi, a full disk or a closed session file must never break a timer.
	}
}

/**
 * A clear that names what it cancels. A shutdown or a user cancel only ever cancels the work this
 * activation is holding, so a second process on the same session file — which holds none of it — cannot
 * erase the log of the process that does.
 */
function clearRecord(entry: SessionEntry, reason: ClearReason): TimerStateRecord {
	return {
		v: HEARTBEAT_STATE_VERSION,
		op: "clear",
		at: new Date().toISOString(),
		owner: currentOwner(),
		reason,
		timers: [...entry.timers.keys()],
		heartbeat: entry.heartbeat !== undefined,
	};
}

/** A `heartbeat start`, which both claims ownership and records the tick the next boundary derives from. */
function heartbeatRecord(state: HeartbeatState, at: string): TimerStateRecord {
	const heartbeat: HeartbeatStateData = {
		id: state.id,
		intervalSeconds: state.intervalSeconds,
		message: state.message,
		tick: state.tick,
		createdAt: state.createdAt,
	};
	if (state.lastTickAt !== undefined) {
		heartbeat.lastTickAt = state.lastTickAt;
	}
	return { v: HEARTBEAT_STATE_VERSION, op: "heartbeat", at, owner: currentOwner(), action: "start", heartbeat };
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

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How late a timer fired: minutes below an hour, `H h M min` below a day, `D d H h` above it. A session
 * left waiting for days reads as days and never as a huge minute count.
 */
function lateText(lateMs: number): string {
	if (lateMs < MINUTE_MS) {
		return "under a min";
	}
	const minutes = Math.floor(lateMs / MINUTE_MS);
	if (lateMs < HOUR_MS) {
		return `${minutes} min`;
	}
	if (lateMs < DAY_MS) {
		return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
	}
	return `${Math.floor(lateMs / DAY_MS)} d ${Math.floor((lateMs % DAY_MS) / HOUR_MS)} h`;
}

function two(value: number): string {
	return String(value).padStart(2, "0");
}

/** A due stamp: local `HH:MM` for today, `YYYY-MM-DD HH:MM` otherwise, so an old due date is unambiguous. */
function dueText(dueAt: number, nowMs: number): string {
	const due = new Date(dueAt);
	const clock = `${two(due.getHours())}:${two(due.getMinutes())}`;
	const today = new Date(nowMs).toDateString() === due.toDateString();
	return today ? clock : `${due.getFullYear()}-${two(due.getMonth() + 1)}-${two(due.getDate())} ${clock}`;
}

/** One line for a single overdue timer, one header and a line each for several, sorted by due time. */
function recoveryContent(timers: readonly { timer: RestoredTimer; dueAt: number }[], nowMs: number): string {
	if (timers.length === 1) {
		const { timer, dueAt } = timers[0];
		return `⏰ ${timer.id} fired ${lateText(nowMs - dueAt)} late (due ${dueText(dueAt, nowMs)}; pi was not running): ${timer.message}`;
	}
	const lines = timers.map(
		({ timer, dueAt }) =>
			`- ${timer.id}: ${lateText(nowMs - dueAt)} late, due ${dueText(dueAt, nowMs)}: ${timer.message}`,
	);
	return `⏰ ${timers.length} timers fired while pi was not running:\n${lines.join("\n")}`;
}

/**
 * How an activation relates to the key it binds to.
 *
 * - `adopted`: a detached entry from a reload; this activation owns it from now on.
 * - `standalone`: the key belongs to another activation (or to an entry written by an older version, which
 *   `attach` disposes and replaces). It must not replay the log and must not write to it.
 * - `fresh`: no entry at all, so the log is the authority and this activation restores from it.
 */
export type BindMode = "adopted" | "standalone" | "fresh";

/**
 * Adopt a detached entry on a reload (flush deferred so no run starts inside the reload). Otherwise a detached
 * entry is replaced, and a live one is left to its activation: this one runs standalone, off the registry.
 */
function attach(key: string, reason: string, deliver: Deliver): { entry: SessionEntry; mode: BindMode } {
	const sessions = registry();
	const existing = sessions.get(key);
	if (existing?.version === 1) {
		if (existing.deliver === undefined && reason === "reload") {
			clearTimeout(existing.detachTimer);
			existing.deliver = deliver;
			setTimeout(() => flush(existing), 0);
			return { entry: existing, mode: "adopted" };
		}
		if (existing.deliver !== undefined) {
			const entry = createEntry();
			entry.deliver = deliver;
			return { entry, mode: "standalone" };
		}
	}
	const entry = createEntry();
	entry.deliver = deliver;
	if (existing !== undefined) {
		// A detached entry on a non-reload start, or one written by an older version: replaced.
		existing.dispose();
		sessions.set(key, entry);
		return { entry, mode: existing.version === 1 ? "fresh" : "standalone" };
	}
	sessions.set(key, entry);
	return { entry, mode: "fresh" };
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
	private readonly persistNow: (record: TimerStateRecord) => void;

	/** Starts on a standalone entry; `bind` moves it onto the session registry at session_start. */
	constructor(pi: ExtensionAPI) {
		this.deliverNow = (message) => deliverVia(pi, message);
		this.persistNow = (record) => pi.appendEntry(HEARTBEAT_STATE_ENTRY, record);
		this.session = createEntry();
		this.session.deliver = this.deliverNow;
	}

	// ── Session lifecycle ───────────────────────────────────────────

	/**
	 * Bind the manager to a session and report how it relates to the key. Disposing the current entry
	 * first is safe only because pi emits `session_start` once per activation (1.4.0 and 0.84.1): a second
	 * `session_start{reason:"reload"}` on this manager would adopt the just-disposed entry and drop the
	 * armed timers.
	 *
	 * The sink is installed on every mode but `standalone`: an activation that does not own the key must
	 * not rewrite the log the owning activation is still writing to.
	 */
	bind(key: string, reason: string): BindMode {
		this.session.dispose();
		this.sessionKey = key;
		const { entry, mode } = attach(key, reason, this.deliverNow);
		this.session = entry;
		if (mode !== "standalone") {
			entry.persist = this.persistNow;
		}
		return mode;
	}

	/** session_shutdown{reload}: stop delivering; the reloaded activation adopts the armed state. */
	detach(): void {
		const entry = this.session;
		const key = this.sessionKey;
		entry.deliver = undefined;
		entry.persist = undefined;
		clearTimeout(entry.detachTimer);
		entry.detachTimer = setTimeout(() => retire(key, entry), DETACH_GRACE_MS).unref();
	}

	/**
	 * session_shutdown (any other reason): one `clear` for the whole session, then tear the armed state
	 * down. Writing before retiring is deliberate — a stale pi makes the sink throw, and that throw must
	 * not keep the in-memory timers alive.
	 */
	end(): void {
		writeRecord(this.session, clearRecord(this.session, "shutdown"));
		retire(this.sessionKey, this.session);
	}

	/**
	 * session_start{fork}: `/fork` copies this branch's custom entries into a new file, so the fork empties
	 * its own copy — a clear with no `timers` — before it replays. The parent file keeps its own.
	 */
	clearInherited(): void {
		writeRecord(this.session, { v: HEARTBEAT_STATE_VERSION, op: "clear", at: new Date().toISOString(), owner: currentOwner(), reason: "fork" });
	}

	/**
	 * Adoption backfill: the reload gap had no sink, so the adopted entry's live timers, its heartbeat and
	 * the wakes queued in the gap were never written. Without the backfilled `fire`, a later crash would
	 * wake a timer that already woke once.
	 */
	claim(): void {
		const entry = this.session;
		const at = new Date().toISOString();
		const owner = currentOwner();
		for (const [id, timer] of entry.timers) {
			writeRecord(entry, {
				v: HEARTBEAT_STATE_VERSION,
				op: "arm",
				at,
				owner,
				timer: { id, seconds: timer.seconds, message: timer.message, createdAt: timer.createdAt },
			});
		}
		if (entry.heartbeat) {
			writeRecord(entry, heartbeatRecord(entry.heartbeat.state, at));
		}
		for (const queued of entry.pending) {
			const details = queued.message.details;
			if (details.type !== "timer" || typeof details.timerId !== "string" || typeof details.firedAt !== "string") {
				continue;
			}
			writeRecord(entry, {
				v: HEARTBEAT_STATE_VERSION,
				op: "fire",
				at,
				owner,
				id: details.timerId,
				dueAt: typeof details.dueAt === "string" ? details.dueAt : details.firedAt,
				firedAt: details.firedAt,
			});
		}
	}

	/**
	 * Re-arm what the log still holds on a `fresh` entry, after the replay already dropped the work a live
	 * process owns. Every re-arm is written before it is armed, so a crash right after `session_start`
	 * cannot lose it; an overdue timer is written as one `fire` and wakes the agent once, in one message.
	 */
	restore(replayed: ReplayResult): void {
		const entry = this.session;
		entry.timerCounter = Math.max(entry.timerCounter, replayed.timerCounter);
		entry.heartbeatIdCounter = Math.max(entry.heartbeatIdCounter, replayed.heartbeatIdCounter);
		const nowMs = Date.now();
		const at = new Date(nowMs).toISOString();
		const owner = currentOwner();
		const overdue: { timer: RestoredTimer; dueAt: number }[] = [];
		for (const timer of replayed.timers) {
			const dueAt = Date.parse(timer.createdAt) + timer.seconds * 1000;
			if (dueAt <= nowMs) {
				overdue.push({ timer, dueAt });
				continue;
			}
			writeRecord(entry, {
				v: HEARTBEAT_STATE_VERSION,
				op: "arm",
				at,
				owner,
				timer: { id: timer.id, seconds: timer.seconds, message: timer.message, createdAt: timer.createdAt },
			});
			this.armTimer({ id: timer.id, seconds: timer.seconds, message: timer.message, createdAt: timer.createdAt, dueAt });
		}
		if (replayed.heartbeat) {
			this.resumeHeartbeat(replayed.heartbeat, at);
		}
		if (overdue.length > 0) {
			this.queueRecovery(overdue, at);
		}
	}

	// ── One-shot timers ─────────────────────────────────────────────

	setTimer(seconds: number, message: string, id?: string): string {
		const entry = this.session;
		if (id !== undefined && id.length > MAX_LISTABLE_TIMER_ID_LENGTH) {
			throw new Error(
				`Timer id is ${id.length} UTF-16 units long; at most ${MAX_LISTABLE_TIMER_ID_LENGTH} are allowed, so the background-work item "timer:<id>" fits its 256-unit budget. The tool's 200-character limit counts grapheme clusters, so an id of astral characters can pass it and still be refused here.`,
			);
		}
		const timerId = id ?? `timer-${++entry.timerCounter}`;

		// Cancel existing timer with same ID
		this.cancelTimer(timerId);

		const createdAt = new Date().toISOString();
		const dueAt = Date.parse(createdAt) + seconds * 1000;
		// Written before arming: an arm lost to a crash is a timer that never existed, which is the only
		// failure a crash between these two lines may cause.
		writeRecord(entry, {
			v: HEARTBEAT_STATE_VERSION,
			op: "arm",
			at: createdAt,
			owner: currentOwner(),
			timer: { id: timerId, seconds, message, createdAt },
		});
		this.armTimer({ id: timerId, seconds, message, createdAt, dueAt });
		return timerId;
	}

	cancelTimer(id: string): boolean {
		const timer = this.session.timers.get(id);
		if (timer) {
			clearTimeout(timer.timeout);
			this.session.timers.delete(id);
			writeRecord(this.session, {
				v: HEARTBEAT_STATE_VERSION,
				op: "cancel",
				at: new Date().toISOString(),
				owner: currentOwner(),
				id,
			});
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
		writeRecord(entry, heartbeatRecord(state, state.createdAt));
		this.tickEvery(state);
		return { ...state };
	}

	stopHeartbeat(): HeartbeatState | undefined {
		const entry = this.session;
		const stopped = haltHeartbeat(entry);
		if (stopped) {
			writeRecord(entry, {
				v: HEARTBEAT_STATE_VERSION,
				op: "heartbeat",
				at: new Date().toISOString(),
				owner: currentOwner(),
				action: "stop",
				id: stopped.id,
			});
		}
		return stopped;
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
		const entry = this.session;
		// Named before the in-memory state goes, so the record says what the user cancelled.
		const record = clearRecord(entry, "user");
		clearArmed(entry);
		writeRecord(entry, record);
	}

	// ── Internals: arming, firing, recovery ─────────────────────────

	/** Arm one timer and its fire callback; the caller has already persisted the `arm`. */
	private armTimer(timer: TimerState & { dueAt: number }): void {
		const entry = this.session;
		const timeout = setTimeout(
			() => this.fireTimer(timer),
			Math.max(0, timer.dueAt - Date.now()),
		);
		entry.timers.set(timer.id, { timeout, seconds: timer.seconds, message: timer.message, createdAt: timer.createdAt });
	}

	/** One timer came due: drop it, write the `fire` before the wake, then queue or deliver the wake. */
	private fireTimer(timer: TimerState & { dueAt: number }): void {
		const entry = this.session;
		entry.timers.delete(timer.id);
		const firedAt = new Date().toISOString();
		writeRecord(entry, {
			v: HEARTBEAT_STATE_VERSION,
			op: "fire",
			at: firedAt,
			owner: currentOwner(),
			id: timer.id,
			dueAt: new Date(timer.dueAt).toISOString(),
			firedAt,
		});
		send(entry, {
			message: {
				customType: "heartbeat-timer",
				content: `⏰ Timer [${timer.id}] fired (after ${timer.seconds}s): ${timer.message}`,
				display: true,
				details: {
					type: "timer",
					timerId: timer.id,
					seconds: timer.seconds,
					message: timer.message,
					dueAt: new Date(timer.dueAt).toISOString(),
					firedAt,
				},
			},
		});
	}

	/** Run one heartbeat callback: `tick` counts callbacks, not delivered pings, as it always has. */
	private heartbeatTick(state: HeartbeatState): void {
		state.tick++;
		state.lastTickAt = new Date().toISOString();
		send(this.session, {
			heartbeatId: state.id,
			message: {
				customType: "heartbeat-ping",
				content: `💓 Heartbeat #${state.id} tick ${state.tick} (every ${state.intervalSeconds}s): ${state.message}`,
				display: true,
				details: {
					type: "heartbeat",
					heartbeatId: state.id,
					tick: state.tick,
					intervalSeconds: state.intervalSeconds,
					message: state.message,
					firedAt: new Date().toISOString(),
				},
			},
		});
	}

	/** The regular phase: one callback every interval, starting now. */
	private tickEvery(state: HeartbeatState): void {
		const entry = this.session;
		const interval = setInterval(() => this.heartbeatTick(state), state.intervalSeconds * 1000);
		entry.heartbeat = { interval, state };
	}

	/**
	 * A restored heartbeat whose boundary is still ahead: one callback at that boundary, then the regular
	 * phase from it. `lastTickAt` keeps its persisted value, so the footer counts down to the same boundary
	 * instead of pinning at 0:00.
	 */
	private tickAt(state: HeartbeatState, delayMs: number): void {
		const timeout = setTimeout(() => {
			this.heartbeatTick(state);
			if (this.session.heartbeat?.state === state) {
				this.tickEvery(state);
			}
		}, Math.max(0, delayMs));
		this.session.heartbeat = { interval: timeout, state };
	}

	/**
	 * Resume the heartbeat the log still holds. The next boundary is derived from the last tick, not from
	 * `tick`: Node coalesces the interval callbacks it misses, so the counter lags real time after a stall.
	 * One missed boundary means one catch-up ping, `tick + 1` and `lastTickAt` now, never one ping per gap.
	 */
	private resumeHeartbeat(restored: RestoredHeartbeat, at: string): void {
		const entry = this.session;
		const state: HeartbeatState = {
			id: restored.id,
			intervalSeconds: restored.intervalSeconds,
			message: restored.message,
			tick: restored.tick,
			createdAt: restored.createdAt,
		};
		if (restored.lastTickAt !== undefined) {
			state.lastTickAt = restored.lastTickAt;
		}
		const boundary = Date.parse(state.lastTickAt ?? state.createdAt) + state.intervalSeconds * 1000;
		const nowMs = Date.now();
		if (boundary > nowMs) {
			writeRecord(entry, heartbeatRecord(state, at));
			this.tickAt(state, boundary - nowMs);
			return;
		}
		state.tick++;
		state.lastTickAt = new Date(nowMs).toISOString();
		writeRecord(entry, heartbeatRecord(state, at));
		send(entry, {
			heartbeatId: state.id,
			message: {
				customType: "heartbeat-ping",
				content: `💓 Heartbeat #${state.id} resumed after pi was not running (every ${state.intervalSeconds}s): ${state.message}`,
				display: true,
				details: {
					type: "heartbeat",
					resumed: true,
					heartbeatId: state.id,
					tick: state.tick,
					intervalSeconds: state.intervalSeconds,
					message: state.message,
					firedAt: state.lastTickAt,
				},
			},
		});
		this.tickEvery(state);
	}

	/**
	 * The timers that came due while pi was not running: one `fire` each, written before the wake, then a
	 * single queued wake flushed after `session_start` so no turn starts inside the startup sequence.
	 */
	private queueRecovery(overdue: { timer: RestoredTimer; dueAt: number }[], at: string): void {
		const entry = this.session;
		const owner = currentOwner();
		const firedAt = new Date().toISOString();
		const sorted = [...overdue].sort((a, b) => a.dueAt - b.dueAt);
		const timers = sorted.map(({ timer, dueAt }) => {
			writeRecord(entry, {
				v: HEARTBEAT_STATE_VERSION,
				op: "fire",
				at,
				owner,
				id: timer.id,
				dueAt: new Date(dueAt).toISOString(),
				firedAt,
			});
			return { timer, dueAt };
		});
		const nowMs = Date.now();
		entry.queueCounter = (entry.queueCounter ?? 0) + 1;
		entry.pending.push({
			seq: entry.queueCounter,
			message: {
				customType: "heartbeat-timer",
				content: recoveryContent(timers, nowMs),
				display: true,
				details: {
					type: "timer-recovery",
					timers: timers.map(({ timer, dueAt }) => ({
						timerId: timer.id,
						dueAt: new Date(dueAt).toISOString(),
						firedAt,
						seconds: timer.seconds,
						message: timer.message,
					})),
				},
			},
		});
		setTimeout(() => flush(entry), 0);
	}
}
