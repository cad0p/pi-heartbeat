import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PersistOwner } from "../../src/process-identity.js";
import {
	HEARTBEAT_STATE_ENTRY,
	type ReplayableEntry,
	replaySessionState,
	repairTornTail,
} from "../../src/session-state.js";
import { MAX_LISTABLE_TIMER_ID_LENGTH } from "../../src/timer-manager.js";

const AT = "2026-10-28T12:00:00.000Z";
const OWNER: PersistOwner = { pid: 4242, boot: "boot-a", start: "100", uptime: 5 };
/** Nothing in this file is ever owned by a live process unless the case says so. */
const DEAD = { alive: () => false };

function entry(record: unknown): ReplayableEntry {
	return { type: "custom", customType: HEARTBEAT_STATE_ENTRY, data: record };
}

function arm(id: string, seconds = 60, createdAt = AT, owner: PersistOwner = OWNER): ReplayableEntry {
	return entry({ v: 1, op: "arm", at: AT, owner, timer: { id, seconds, message: `${id} message`, createdAt } });
}

function cancel(id: string): ReplayableEntry {
	return entry({ v: 1, op: "cancel", at: AT, owner: OWNER, id });
}

function fire(id: string): ReplayableEntry {
	return entry({ v: 1, op: "fire", at: AT, owner: OWNER, id, dueAt: AT, firedAt: AT });
}

function heartbeatStart(id: number, tick = 0, owner: PersistOwner = OWNER): ReplayableEntry {
	return entry({
		v: 1,
		op: "heartbeat",
		at: AT,
		owner,
		action: "start",
		heartbeat: { id, intervalSeconds: 60, message: "check", tick, createdAt: AT },
	});
}

function heartbeatStop(id: number): ReplayableEntry {
	return entry({ v: 1, op: "heartbeat", at: AT, owner: OWNER, action: "stop", id });
}

function cleared(reason = "user"): ReplayableEntry {
	return entry({ v: 1, op: "clear", at: AT, owner: OWNER, reason });
}

describe("session state: replay", () => {
	it("(1) folds arm, cancel and fire", () => {
		const result = replaySessionState(
			[arm("timer-1"), arm("job"), arm("timer-2"), cancel("job"), fire("timer-2")],
			DEAD,
		);

		expect(result.timers.map((timer) => timer.id)).toEqual(["timer-1"]);
		expect(result.invalid).toBe(0);
		expect(result.deferred).toBe(0);
	});

	it("(2) the last arm per id wins, clock and message included", () => {
		const result = replaySessionState(
			[arm("job", 10, "2026-10-28T12:00:00.000Z"), arm("job", 30, "2026-10-28T12:05:00.000Z")],
			DEAD,
		);

		expect(result.timers).toEqual([
			{ id: "job", seconds: 30, message: "job message", createdAt: "2026-10-28T12:05:00.000Z", owner: OWNER },
		]);
	});

	it("(3) the counter is a high-water mark: neither cancel nor clear lowers it", () => {
		const result = replaySessionState([arm("timer-3"), cancel("timer-3"), cleared(), arm("timer-5")], DEAD);

		expect(result.timerCounter).toBe(5);
		expect(result.timers.map((timer) => timer.id)).toEqual(["timer-5"]);
		expect(replaySessionState([arm("timer-9"), cleared()], DEAD).timerCounter).toBe(9);
	});

	it("(4) folds the heartbeat singleton and its counter", () => {
		const started = replaySessionState([heartbeatStart(1), heartbeatStop(1), heartbeatStart(4, 3)], DEAD);
		expect(started.heartbeat).toEqual({
			id: 4,
			intervalSeconds: 60,
			message: "check",
			tick: 3,
			createdAt: AT,
			owner: OWNER,
		});
		expect(started.heartbeatIdCounter).toBe(4);

		const stopped = replaySessionState([heartbeatStart(1), heartbeatStop(1)], DEAD);
		expect(stopped.heartbeat).toBeUndefined();
		expect(stopped.heartbeatIdCounter).toBe(1);
	});

	it("(5) unknown version, unknown op, wrong types and missing fields are skipped and counted", () => {
		const broken: unknown[] = [
			null,
			"a string",
			[],
			{ v: 2, op: "arm", at: AT, owner: OWNER, timer: { id: "x", seconds: 1, message: "m", createdAt: AT } },
			{ v: 1, op: "nope", at: AT, owner: OWNER },
			{ v: 1, op: "arm", at: AT, owner: OWNER },
			{ v: 1, op: "arm", at: "not a date", owner: OWNER, timer: { id: "x", seconds: 1, message: "m", createdAt: AT } },
			{ v: 1, op: "arm", at: AT, owner: OWNER, timer: { id: "x", seconds: "1", message: "m", createdAt: AT } },
			{ v: 1, op: "arm", at: AT, owner: OWNER, timer: { id: "x", seconds: 1, createdAt: AT } },
			{ v: 1, op: "cancel", at: AT, owner: { pid: "1" }, id: "x" },
			{ v: 1, op: "heartbeat", at: AT, owner: OWNER, action: "start", heartbeat: { id: 1 } },
			{ v: 1, op: "clear", at: AT, owner: OWNER, reason: "reboot" },
		];
		const result = replaySessionState([...broken.map(entry), arm("timer-1")], DEAD);

		expect(result.invalid).toBe(broken.length);
		expect(result.deferred).toBe(0);
		expect(result.timers.map((timer) => timer.id)).toEqual(["timer-1"]);
	});

	it("(6) an id the background-work consumer cannot list is not restored", () => {
		const tooLong = "b".repeat(MAX_LISTABLE_TIMER_ID_LENGTH + 1);
		const withControl = "a\u0001b";
		const result = replaySessionState([arm(tooLong), arm(withControl), arm("trimmed ")], DEAD);

		expect(result.timers).toEqual([]);
		expect(result.invalid).toBe(3);
	});

	it("(7) a cancel or fire for an unknown id is a no-op, not an invalid record", () => {
		const result = replaySessionState([fire("ghost"), cancel("ghost"), arm("timer-1")], DEAD);

		expect(result.timers.map((timer) => timer.id)).toEqual(["timer-1"]);
		expect(result.invalid).toBe(0);
	});

	it("(8) a live owner is deferred, and force overrides it only for the records it names", () => {
		const live: PersistOwner = { pid: 777, boot: "boot-a", start: "100", uptime: 5 };
		const alive = { alive: (owner: PersistOwner) => owner.pid === live.pid };
		const branch = [arm("timer-1", 60, AT, live), heartbeatStart(2, 0, live)];

		const deferred = replaySessionState(branch, alive);
		expect(deferred.timers).toEqual([]);
		expect(deferred.heartbeat).toBeUndefined();
		expect(deferred.deferred).toBe(2);
		expect(deferred.invalid).toBe(0);

		const mine = replaySessionState(branch, { ...alive, force: (owner) => owner.pid === live.pid });
		expect(mine.timers.map((timer) => timer.id)).toEqual(["timer-1"]);
		expect(mine.heartbeat?.id).toBe(2);
		expect(mine.deferred).toBe(0);

		// A predicate naming another process leaves this one's work alone: a reload can only reclaim its own.
		const theirs = replaySessionState(branch, { ...alive, force: (owner) => owner.pid !== live.pid });
		expect(theirs.timers).toEqual([]);
		expect(theirs.heartbeat).toBeUndefined();
		expect(theirs.deferred).toBe(2);
	});

	it("(9) a clear cancels the work it names, and one with no timers empties the branch", () => {
		const named = replaySessionState(
			[
				arm("timer-1"),
				arm("timer-2"),
				heartbeatStart(1),
				entry({ v: 1, op: "clear", at: AT, owner: OWNER, reason: "shutdown", timers: ["timer-2"], heartbeat: true }),
			],
			DEAD,
		);
		// Only the timer it named is gone; the one a second process never held survives, and its heartbeat
		// still stopped because that one it did hold.
		expect(named.timers.map((timer) => timer.id)).toEqual(["timer-1"]);
		expect(named.heartbeat).toBeUndefined();
		expect(named.invalid).toBe(0);

		const emptied = replaySessionState([arm("timer-1"), heartbeatStart(1), cleared("fork")], DEAD);
		expect(emptied.timers).toEqual([]);
		expect(emptied.heartbeat).toBeUndefined();
	});

	it("(10) a malformed timers list or heartbeat flag costs the record, not the replay", () => {
		const broken = [
			{ v: 1, op: "clear", at: AT, owner: OWNER, reason: "shutdown", timers: "timer-1" },
			{ v: 1, op: "clear", at: AT, owner: OWNER, reason: "shutdown", timers: ["ok", 7] },
			{ v: 1, op: "clear", at: AT, owner: OWNER, reason: "shutdown", timers: [], heartbeat: "yes" },
		];
		const result = replaySessionState([...broken.map(entry), arm("timer-1")], DEAD);

		expect(result.invalid).toBe(broken.length);
		expect(result.timers.map((timer) => timer.id)).toEqual(["timer-1"]);
	});
});

describe("session state: torn tail repair", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir !== undefined) {
			rmSync(dir, { recursive: true, force: true });
			dir = undefined;
		}
	});

	function fileWith(content: string): string {
		dir ??= mkdtempSync(join(tmpdir(), "pi-heartbeat-"));
		const file = join(dir, "session.jsonl");
		writeFileSync(file, content);
		return file;
	}

	it("(9) appends one newline to a cut tail, and leaves every other file untouched", () => {
		const cut = fileWith('{"type":"session","id":"a"}\n{"type":"custom","customType":"pi-heartbeat.state","data":{"op":"arm"');
		const cutBefore = readFileSync(cut, "utf8");
		repairTornTail(cut);
		expect(readFileSync(cut, "utf8")).toBe(`${cutBefore}\n`);
		repairTornTail(cut);
		expect(readFileSync(cut, "utf8")).toBe(`${cutBefore}\n`);

		const complete = fileWith('{"type":"session","id":"a"}\n{"type":"custom"}\n');
		const before = readFileSync(complete);
		repairTornTail(complete);
		expect(readFileSync(complete).equals(before)).toBe(true);

		const empty = fileWith("");
		repairTornTail(empty);
		expect(statSync(empty).size).toBe(0);

		// A session whose header never ended is rejected by pi at load: a newline would not help.
		const tornHeader = fileWith('{"type":"session","id":"a"');
		const headerBefore = readFileSync(tornHeader);
		repairTornTail(tornHeader);
		expect(readFileSync(tornHeader).equals(headerBefore)).toBe(true);

		expect(() => repairTornTail(undefined)).not.toThrow();
	});
});
