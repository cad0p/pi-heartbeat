/**
 * The session's armed-work log: one custom entry per action, folded root->leaf when a new process opens
 * the session.
 *
 * The log is append-only like the session itself, so it survives a crash between any two lines. One clock
 * per timer (`createdAt + seconds`, which the footer already uses) means a restart never extends a wait and
 * a tampered record has no second source to diverge from. Delivery is at-least-once, never at-most-once: a
 * torn `fire` is dropped while its `arm` survives, so the next start wakes once more.
 */

import { appendFileSync, closeSync, openSync, readSync, statSync } from "node:fs";
import { isListableTimerId } from "./background-work.js";
import { type PersistOwner, ownerAlive } from "./process-identity.js";

/** Custom entry type: never reaches the model, never participates in the context. */
export const HEARTBEAT_STATE_ENTRY = "pi-heartbeat.state";
/** The only log version this release writes and reads; any other costs one skipped record. */
export const HEARTBEAT_STATE_VERSION = 1;
/** Bytes read to find the end of the session header; a header is a few hundred at most. */
const HEADER_PROBE_BYTES = 1024;

/** Why a whole session's log was emptied. */
export type ClearReason = "shutdown" | "fork" | "user";

export interface TimerState {
	id: string;
	seconds: number;
	message: string;
	createdAt: string;
}

export interface HeartbeatStateData {
	id: number;
	intervalSeconds: number;
	message: string;
	tick: number;
	createdAt: string;
	lastTickAt?: string;
}

/** One action. The last record per id wins; a `clear` folds the whole set to empty. */
export type TimerStateRecord =
	| { v: typeof HEARTBEAT_STATE_VERSION; op: "arm"; at: string; owner: PersistOwner; timer: TimerState }
	| { v: typeof HEARTBEAT_STATE_VERSION; op: "cancel"; at: string; owner: PersistOwner; id: string }
	| {
			v: typeof HEARTBEAT_STATE_VERSION;
			op: "fire";
			at: string;
			owner: PersistOwner;
			id: string;
			dueAt: string;
			firedAt: string;
	  }
	| {
			v: typeof HEARTBEAT_STATE_VERSION;
			op: "heartbeat";
			at: string;
			owner: PersistOwner;
			action: "start";
			heartbeat: HeartbeatStateData;
	  }
	| { v: typeof HEARTBEAT_STATE_VERSION; op: "heartbeat"; at: string; owner: PersistOwner; action: "stop"; id: number }
	| {
			v: typeof HEARTBEAT_STATE_VERSION;
			op: "clear";
			at: string;
			owner: PersistOwner;
			reason: ClearReason;
			/** The timers this clear cancels. Absent, it cancels every timer in the branch (a fork's copy). */
			timers?: string[];
			/** Whether it also stops the heartbeat. */
			heartbeat?: boolean;
	  };

/** A timer the log still holds armed. */
export interface RestoredTimer extends TimerState {
	owner: PersistOwner;
}

/** The heartbeat the log still holds running. */
export interface RestoredHeartbeat extends HeartbeatStateData {
	owner: PersistOwner;
}

export interface ReplayResult {
	timers: RestoredTimer[];
	heartbeat?: RestoredHeartbeat;
	/** High-water mark over every armed id: a new auto id cannot replace a restored one. */
	timerCounter: number;
	heartbeatIdCounter: number;
	/** Records dropped as unreadable. An owner skip is never one of these. */
	invalid: number;
	/** Items a live process still owns: left untouched, and never counted invalid. */
	deferred: number;
}

/** The fields of a session entry this module reads; structural, so no pi type is needed. */
export interface ReplayableEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export type OwnerCheck = (owner: PersistOwner) => boolean;

export interface ReplayOptions {
	/**
	 * Which records to restore even though their owner reads as alive: a reload whose detach entry expired,
	 * where the recorded pid is this very process and nobody else is counting the work down. Scoped to the
	 * caller's own records, so it can never take work from another live process.
	 */
	force?: OwnerCheck;
	/** Liveness, injectable for tests. */
	alive?: OwnerCheck;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isPositive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseOwner(value: unknown): PersistOwner | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const { pid, boot, start, uptime } = value;
	if (!isCount(pid) || pid === 0 || typeof boot !== "string") {
		return undefined;
	}
	if (start !== undefined && typeof start !== "string") {
		return undefined;
	}
	if (typeof uptime !== "number" || !Number.isFinite(uptime)) {
		return undefined;
	}
	return { pid, boot, start, uptime };
}

function parseArm(data: Record<string, unknown>, at: string, owner: PersistOwner): TimerStateRecord | undefined {
	const timer = data.timer;
	if (!isRecord(timer)) {
		return undefined;
	}
	const { id, seconds, message, createdAt } = timer;
	// An id the background-work consumer cannot list only comes from a corrupt record: never re-arm it.
	if (typeof id !== "string" || !isListableTimerId(id)) {
		return undefined;
	}
	if (!isPositive(seconds) || typeof message !== "string" || !isTimestamp(createdAt)) {
		return undefined;
	}
	return { v: HEARTBEAT_STATE_VERSION, op: "arm", at, owner, timer: { id, seconds, message, createdAt } };
}

/**
 * A clear names what it cancels, because a shutdown can only cancel the work that activation was holding:
 * a second process on the same session file holds none of it and must not wipe the log of the process that
 * does. A clear without `timers` empties the branch instead, which is what a fork writes for the parent's
 * copied log.
 */
function parseClear(data: Record<string, unknown>, at: string, owner: PersistOwner): TimerStateRecord | undefined {
	const { reason, timers, heartbeat } = data;
	if (reason !== "shutdown" && reason !== "fork" && reason !== "user") {
		return undefined;
	}
	if (timers !== undefined && (!Array.isArray(timers) || !timers.every((id) => typeof id === "string"))) {
		return undefined;
	}
	if (heartbeat !== undefined && typeof heartbeat !== "boolean") {
		return undefined;
	}
	return {
		v: HEARTBEAT_STATE_VERSION,
		op: "clear",
		at,
		owner,
		reason,
		...(timers === undefined ? {} : { timers: [...timers] }),
		...(heartbeat === undefined ? {} : { heartbeat }),
	};
}

function parseHeartbeatStart(data: Record<string, unknown>, at: string, owner: PersistOwner): TimerStateRecord | undefined {
	const heartbeat = data.heartbeat;
	if (!isRecord(heartbeat)) {
		return undefined;
	}
	const { id, intervalSeconds, message, tick, createdAt, lastTickAt } = heartbeat;
	if (!isCount(id) || id === 0 || !isPositive(intervalSeconds) || typeof message !== "string") {
		return undefined;
	}
	if (!isCount(tick) || !isTimestamp(createdAt)) {
		return undefined;
	}
	if (lastTickAt !== undefined && !isTimestamp(lastTickAt)) {
		return undefined;
	}
	const state: HeartbeatStateData = { id, intervalSeconds, message, tick, createdAt };
	if (lastTickAt !== undefined) {
		state.lastTickAt = lastTickAt;
	}
	return { v: HEARTBEAT_STATE_VERSION, op: "heartbeat", at, owner, action: "start", heartbeat: state };
}

/** One stored record, or `undefined` when any field of it is unreadable: never throws. */
function parseRecord(data: unknown): TimerStateRecord | undefined {
	if (!isRecord(data) || data.v !== HEARTBEAT_STATE_VERSION) {
		return undefined;
	}
	const owner = parseOwner(data.owner);
	const at = data.at;
	if (owner === undefined || !isTimestamp(at)) {
		return undefined;
	}
	switch (data.op) {
		case "arm":
			return parseArm(data, at, owner);
		case "cancel":
			return typeof data.id === "string" ? { v: HEARTBEAT_STATE_VERSION, op: "cancel", at, owner, id: data.id } : undefined;
		case "fire":
			return typeof data.id === "string" && isTimestamp(data.dueAt) && isTimestamp(data.firedAt)
				? { v: HEARTBEAT_STATE_VERSION, op: "fire", at, owner, id: data.id, dueAt: data.dueAt, firedAt: data.firedAt }
				: undefined;
		case "heartbeat":
			if (data.action === "start") {
				return parseHeartbeatStart(data, at, owner);
			}
			return data.action === "stop" && isCount(data.id) && data.id > 0
				? { v: HEARTBEAT_STATE_VERSION, op: "heartbeat", at, owner, action: "stop", id: data.id }
				: undefined;
		case "clear":
			return parseClear(data, at, owner);
		default:
			return undefined;
	}
}

/** The auto-id counter a restored id implies: `timer-7` -> 7, a user id -> 0. */
function autoCounter(id: string): number {
	const match = /^timer-(\d+)$/.exec(id);
	return match === null ? 0 : Number(match[1]);
}

/**
 * Fold the branch root->leaf: `arm` sets an id, `cancel`/`fire` delete it, a heartbeat start replaces the
 * singleton and its stop deletes it, and `clear` empties both. Counters are high-water marks over every id
 * ever seen, so a clear never lowers them and a fresh auto id can never silently replace an armed one.
 *
 * Work a live process still owns is left out of the result and counted in `deferred`; `force` overrides
 * that for the records it names, which is only correct for this process's own orphans — a reload whose
 * detach entry expired, where nothing else is counting the work down.
 */
export function replaySessionState(branch: readonly ReplayableEntry[], options: ReplayOptions = {}): ReplayResult {
	const alive = options.alive ?? ownerAlive;
	const force = options.force;
	/** This process's own orphaned work is taken back; anyone else's is left alone. */
	const takes = (owner: PersistOwner): boolean => force?.(owner) === true || !alive(owner);
	const armed = new Map<string, RestoredTimer>();
	let heartbeat: RestoredHeartbeat | undefined;
	let timerCounter = 0;
	let heartbeatIdCounter = 0;
	let invalid = 0;
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== HEARTBEAT_STATE_ENTRY) {
			continue;
		}
		const record = parseRecord(entry.data);
		if (record === undefined) {
			invalid++;
			continue;
		}
		switch (record.op) {
			case "arm":
				timerCounter = Math.max(timerCounter, autoCounter(record.timer.id));
				armed.set(record.timer.id, { ...record.timer, owner: record.owner });
				break;
			case "cancel":
			case "fire":
				armed.delete(record.id);
				break;
			case "heartbeat":
				if (record.action === "start") {
					heartbeatIdCounter = Math.max(heartbeatIdCounter, record.heartbeat.id);
					heartbeat = { ...record.heartbeat, owner: record.owner };
				} else {
					heartbeat = undefined;
				}
				break;
			case "clear":
				if (record.timers === undefined) {
					// A fork: the branch was copied from another file, so it starts empty.
					armed.clear();
					heartbeat = undefined;
					break;
				}
				for (const id of record.timers) {
					armed.delete(id);
				}
				if (record.heartbeat === true) {
					heartbeat = undefined;
				}
				break;
		}
	}

	const timers: RestoredTimer[] = [];
	let deferred = 0;
	for (const timer of armed.values()) {
		if (!takes(timer.owner)) {
			deferred++;
			continue;
		}
		timers.push(timer);
	}
	if (heartbeat !== undefined && !takes(heartbeat.owner)) {
		deferred++;
		heartbeat = undefined;
	}
	return { timers, heartbeat, timerCounter, heartbeatIdCounter, invalid, deferred };
}

/**
 * Append one newline when the session file ends in a torn line. pi drops that line at load and, before
 * 1.4.0, does not repair it: the next append lands on the same physical line as the fragment, so this
 * activation's first record is glued to it and lost on the next load. Append-only, no rewrite; pi 1.4.0
 * repairs it itself, so there the file already ends in `\n` and this is a no-op.
 */
export function repairTornTail(file: string | undefined): void {
	if (file === undefined) {
		return;
	}
	try {
		const size = statSync(file).size;
		if (size === 0) {
			// No last byte to inspect, and pi rejects a file without a header at load.
			return;
		}
		const fd = openSync(file, "r");
		try {
			// A session whose header never ended is rejected by pi at load: a newline would not help.
			const head = Buffer.alloc(Math.min(size, HEADER_PROBE_BYTES));
			readSync(fd, head, 0, head.length, 0);
			if (!head.includes(0x0a)) {
				return;
			}
			const last = Buffer.alloc(1);
			if (readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) {
				appendFileSync(file, "\n");
			}
		} finally {
			closeSync(fd);
		}
	} catch {
		// Unreadable or unwritable: leave the file alone.
	}
}
