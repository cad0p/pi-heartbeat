/**
 * Display provider: says what this package's background-work items mean in the
 * @cad0p/pi-background-work footer, instead of a bare item count.
 */

import {
	type BackgroundWorkItem,
	type DescribeContext,
	listBackgroundWorkDisplayProviders,
	registerBackgroundWorkDisplayProvider,
} from "@cad0p/pi-background-work";
import { registry, type SessionEntry } from "./timer-manager.js";

const PROVIDER_NAME = "pi-heartbeat";
/** Longest segment, in graphemes, the footer keeps, the ellipsis included. */
const MAX_SEGMENT = 48;
/** A cut may not shorten a segment below this many graphemes. */
const MIN_CUT = 32;
const TIMER_PREFIX = "timer:";
const HEARTBEAT_PREFIX = "heartbeat:";
const PENDING_PREFIX = "pending:";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemesOf(text: string): string[] {
	return [...segmenter.segment(text)].map((entry) => entry.segment);
}

/** Cap the segment as the footer does: cut at the last space or comma in range, add one ellipsis. */
function capSegment(text: string): string {
	const graphemes = graphemesOf(text);
	if (graphemes.length <= MAX_SEGMENT) {
		return text;
	}
	for (let index = MAX_SEGMENT - 1; index >= MIN_CUT; index--) {
		const grapheme = graphemes[index];
		if (grapheme === " " || grapheme === ",") {
			return `${graphemes.slice(0, index).join("").trimEnd()}…`;
		}
	}
	return `${graphemes.slice(0, MAX_SEGMENT - 1).join("")}…`;
}

/**
 * The timers part, keeping whole entries within the segment limit; an ellipsis marks the ones
 * dropped, so the count always survives a cut.
 */
function timerPart(tokens: string[], used: number, budget: number): string {
	if (tokens.length === 1) {
		const token = tokens[0];
		if (used + graphemesOf(token).length <= budget) {
			return token;
		}
		// One timer whose id alone fills the segment: keep the clock, cut the name. Returning the
		// whole token would push the wake out and leave a dangling separator once the cap cuts.
		const cut = token.lastIndexOf(" ");
		const clock = cut === -1 ? "" : token.slice(cut + 1);
		const id = cut === -1 ? token : token.slice(0, cut);
		const room = Math.max(1, budget - used - graphemesOf(clock).length - 2);
		return `${graphemesOf(id).slice(0, room).join("").trimEnd()}… ${clock}`;
	}
	const head = `${tokens.length} timers: `;
	const kept: string[] = [];
	for (const token of tokens) {
		const candidate = `${head}${[...kept, token].join(", ")}`;
		// The "…" a cut appends is part of the segment: a list landing exactly on the budget
		// would otherwise exceed it and be cut a second time, taking the wake with it.
		const ellipsis = kept.length + 1 < tokens.length ? 1 : 0;
		if (used + graphemesOf(candidate).length + ellipsis > budget) {
			break;
		}
		kept.push(token);
	}
	return kept.length === tokens.length ? `${head}${kept.join(", ")}` : `${head}${kept.join(", ")}…`;
}

/** Time left until `deadlineMs` as `M:SS`; `0:00` once it has passed. */
function remaining(deadlineMs: number, nowMs: number): string {
	const seconds = Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A timer reads its remaining time; one that fired already reads `0:00` while its wake waits. */
function timerToken(entry: SessionEntry, id: string, nowMs: number): string {
	const timer = entry.timers.get(id);
	const deadline = timer === undefined ? nowMs : Date.parse(timer.createdAt) + timer.seconds * 1000;
	return `${id} ${remaining(deadline, nowMs)}`;
}

/**
 * The heartbeat reads the time to its next tick.
 *
 * The base is the last tick's own timestamp, not `tick`: that counter advances once per
 * `setInterval` callback, and Node coalesces the callbacks it misses during a stall, so after one
 * the counter lags real time forever and the countdown pinned at `0:00` while the heartbeat was
 * alive. An entry written before `lastTickAt` existed falls back to the next boundary after
 * `createdAt`, which is never in the past either.
 */
function heartbeatToken(entry: SessionEntry, nowMs: number): string {
	const state = entry.heartbeat?.state;
	if (state === undefined) {
		return `heartbeat ${remaining(nowMs, nowMs)}`;
	}
	const intervalMs = Math.max(1, state.intervalSeconds) * 1000;
	const createdAt = Date.parse(state.createdAt);
	if (!Number.isFinite(createdAt)) {
		return `heartbeat ${remaining(nowMs, nowMs)}`;
	}
	const lastTickAt = state.lastTickAt === undefined ? Number.NaN : Date.parse(state.lastTickAt);
	const deadline = Number.isFinite(lastTickAt)
		? lastTickAt + intervalMs
		: createdAt + (Math.floor((nowMs - createdAt) / intervalMs) + 1) * intervalMs;
	return `heartbeat ${remaining(deadline, nowMs)}`;
}

/** The entry this session binds to, if any; a throw from the registry is the caller's to absorb. */
function sessionEntry(context: DescribeContext): SessionEntry | undefined {
	for (const [key, entry] of registry()) {
		if (entry.version === 1 && context.sessionIds.includes(key)) {
			return entry;
		}
	}
	return undefined;
}

type QueuedMessage = SessionEntry["pending"][number];
type WakeOwner = { timerId: string } | "heartbeat" | undefined;

/**
 * Who owes a queued wake. A heartbeat tick names its heartbeat; a timer wake is read
 * from its message details, since the timer is deleted before its wake is queued.
 * An owner that is gone, or a legacy wake with no owner, is unaccounted.
 */
function wakeOwner(entry: SessionEntry, queued: QueuedMessage | undefined): WakeOwner {
	if (queued === undefined) {
		return undefined;
	}
	if (queued.heartbeatId !== undefined) {
		return entry.heartbeat?.state.id === queued.heartbeatId ? "heartbeat" : undefined;
	}
	const { type, timerId } = queued.message.details;
	return type === "timer" && typeof timerId === "string" && timerId.length > 0 ? { timerId } : undefined;
}

/** The queued message a `pending:<seq>` id names; a legacy id has no seq and names none. */
function queuedFor(entry: SessionEntry, seq: string): QueuedMessage | undefined {
	if (!/^\d+$/.test(seq)) {
		return undefined;
	}
	const wanted = Number(seq);
	return entry.pending.find((queued) => queued.seq === wanted);
}

/**
 * Describes one session's armed work as the footer segment: `timer-1 0:42`,
 * `2 timers: timer-1 0:42, timer-2 1:05`, `heartbeat 4:30 · 2 timers: …`.
 * Queued wakes fold into their owner; a wake with no owner reads `wake queued`.
 * Returns `null` when nothing is armed or the registry cannot be read. Never throws.
 */
export function describeArmedWork(items: readonly BackgroundWorkItem[], context: DescribeContext): string | null {
	try {
		const entry = sessionEntry(context);
		if (entry === undefined) {
			return null;
		}
		const timers = new Map<string, string>();
		let heartbeat: string | undefined;
		let wakes = 0;
		for (const item of items) {
			// Items for another session say nothing about this one.
			if (!context.sessionIds.includes(item.sessionId)) {
				continue;
			}
			if (item.id.startsWith(TIMER_PREFIX)) {
				const id = item.id.slice(TIMER_PREFIX.length);
				timers.set(id, timerToken(entry, id, context.nowMs));
			} else if (item.id.startsWith(HEARTBEAT_PREFIX)) {
				heartbeat = heartbeatToken(entry, context.nowMs);
			} else if (item.id.startsWith(PENDING_PREFIX)) {
				const owner = wakeOwner(entry, queuedFor(entry, item.id.slice(PENDING_PREFIX.length)));
				if (owner === "heartbeat") {
					heartbeat ??= heartbeatToken(entry, context.nowMs);
				} else if (owner === undefined) {
					wakes++;
				} else if (!timers.has(owner.timerId)) {
					timers.set(owner.timerId, timerToken(entry, owner.timerId, context.nowMs));
				}
			}
		}
		const wakeText = wakes === 0 ? undefined : wakes === 1 ? "wake queued" : `${wakes} wakes queued`;
		const parts: string[] = [];
		if (heartbeat !== undefined) {
			parts.push(heartbeat);
		}
		const tokens = [...timers.values()];
		if (tokens.length > 0) {
			// The separator counts too when a heartbeat already leads the segment, and the timers may not
			// spend the room the wake text needs: without the reservation the cap cuts the wake away and
			// leaves a second ellipsis in the timers' own.
			const used = graphemesOf(parts.join(" · ")).length + (parts.length > 0 ? 3 : 0);
			const reserved = wakeText === undefined ? 0 : graphemesOf(wakeText).length + 3;
			parts.push(timerPart(tokens, used, MAX_SEGMENT - reserved));
		}
		if (wakeText !== undefined) {
			parts.push(wakeText);
		}
		return parts.length === 0 ? null : capSegment(parts.join(" · "));
	} catch {
		return null;
	}
}

function displayPresent(): boolean {
	try {
		return listBackgroundWorkDisplayProviders().some((provider) => provider.name === PROVIDER_NAME);
	} catch {
		// A malformed display provider from another extension makes the list throw. Treat that as absent so
		// registration still runs: a same-name registration replaces the old one, so a re-register is harmless.
		return false;
	}
}

/**
 * Registers the display provider once per process, beside the v1 provider. A reload replaces the
 * existing registration; any other session start registers only when no pi-heartbeat display is
 * present. The disposer is never called: other sessions in the process still need the provider.
 */
export function registerDisplayProvider(reason: string): void {
	if (reason !== "reload" && displayPresent()) {
		return;
	}
	try {
		registerBackgroundWorkDisplayProvider({ name: PROVIDER_NAME, describe: describeArmedWork });
	} catch {
		// A malformed display registry must not break session binding.
	}
}
