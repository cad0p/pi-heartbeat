import { randomUUID } from "node:crypto";
import { snapshotBackgroundWork } from "@cad0p/pi-background-work";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeArmedWork } from "../../src/display-provider.js";
import { HEARTBEAT_STATE_ENTRY } from "../../src/session-state.js";
import {
	type Activation,
	activation,
	crash,
	journal,
	listedWork,
	liveOwner,
	resetBackgroundWork,
	resetSessions,
	restart,
	sentContents,
	stateOps,
	stateRecords,
} from "./reload-harness.js";

/** The footer segment this activation's work produces, as of now. */
function footer(act: Activation): string | null {
	const items = snapshotBackgroundWork([act.key]).items;
	return describeArmedWork(items, { sessionId: act.key, sessionIds: [act.key], nowMs: Date.now() });
}

/** The process died `deadForMs` ago (nothing ran in between) and a new one opens the same session. */
function restartAfter(key: string, deadForMs: number): Activation {
	crash(key);
	vi.advanceTimersByTime(deadForMs);
	const act = activation(key);
	act.start("startup");
	return act;
}

/** Append a record to a key's log by hand, as a previous process would have left it. */
function seed(key: string, data: unknown): void {
	journal(key).push({ type: "custom", customType: HEARTBEAT_STATE_ENTRY, data });
}

const NOW = "2026-10-28T12:00:00.000Z";

describe("restart survival: replay and recovery", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
		resetBackgroundWork();
	});

	afterEach(() => {
		resetSessions();
		vi.useRealTimers();
	});

	it("(1) a still-due timer re-arms for its remaining time and fires at createdAt + seconds", async () => {
		const before = activation();
		before.start("startup");
		await before.setTimer(45, "RESTART");
		vi.advanceTimersByTime(20_000);

		const after = restart(before.key);
		vi.advanceTimersByTime(20_000);
		expect(sentContents(after)).toEqual([]);

		vi.advanceTimersByTime(5_000);
		expect(sentContents(after)).toEqual([expect.stringContaining("Timer [timer-1] fired (after 45s): RESTART")]);
		expect(before.sendMessage).not.toHaveBeenCalled();
		expect(stateOps(before.key)).toEqual(["arm", "arm", "fire"]);
	});

	it("(2) an overdue timer fires once, saying how late it is, and not again after another crash", async () => {
		const before = activation();
		before.start("startup");
		await before.setTimer(20, "check CI");

		const after = restartAfter(before.key, 100_000);
		// Nothing starts a turn inside the startup sequence: the wake waits for the deferred flush.
		expect(after.sendMessage).not.toHaveBeenCalled();
		vi.advanceTimersByTime(0);

		const due = new Date(Date.parse(NOW) + 20_000);
		const clock = `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`;
		expect(sentContents(after)).toEqual([`⏰ timer-1 fired 1 min late (due ${clock}; pi was not running): check CI`]);
		expect(after.sendMessage.mock.calls[0][0].details).toMatchObject({ type: "timer-recovery" });

		const second = restart(before.key);
		vi.advanceTimersByTime(60_000);
		expect(sentContents(second)).toEqual([]);
	});

	it("(3) the fire record precedes the queued wake, which is a pending item before the flush", async () => {
		const before = activation();
		before.start("startup");
		await before.setTimer(20, "gap");

		const after = restartAfter(before.key, 30_000);
		expect(stateOps(before.key)).toEqual(["arm", "fire"]);
		expect(after.sendMessage).not.toHaveBeenCalled();
		expect(listedWork(before.key)).toContainEqual(expect.stringMatching(/^pending:\d+$/));

		vi.advanceTimersByTime(0);
		expect(after.sendMessage).toHaveBeenCalledOnce();
	});

	it("(4) work a live process still owns is not re-armed and not written again", async () => {
		const key = randomUUID();
		seed(key, {
			v: 1,
			op: "arm",
			at: NOW,
			owner: liveOwner(),
			timer: { id: "timer-1", seconds: 1, message: "live", createdAt: NOW },
		});

		const act = activation(key);
		act.start("startup");
		vi.advanceTimersByTime(60_000);

		expect(sentContents(act)).toEqual([]);
		expect(stateOps(key)).toEqual(["arm"]);
	});

	it("(5) quit, new and resume write a clear, and a restart revives nothing", async () => {
		for (const reason of ["quit", "new", "resume"]) {
			const act = activation();
			act.start("startup");
			await act.setTimer(10, reason);
			act.shutdown(reason);

			expect(stateOps(act.key)).toEqual(["arm", "clear"]);
			expect(stateRecords(act.key).at(-1)).toMatchObject({ op: "clear", reason: "shutdown" });

			const after = restart(act.key);
			vi.advanceTimersByTime(60_000);
			expect(sentContents(after)).toEqual([]);
		}
	});

	it("(6) a reload adopts: one fire, ids continue, and the gap is backfilled per live timer", async () => {
		const before = activation();
		before.start("startup");
		await before.setTimer(60, "still-due");
		await before.setTimer(10, "gap");
		before.shutdown("reload");
		vi.advanceTimersByTime(10_000);

		const after = activation(before.key);
		after.start("reload");
		// No replay and no re-arm from the log: the gap timer's own arm stays, the live timer gets one
		// backfilled arm, and the queued gap wake gets its fire.
		expect(stateOps(before.key)).toEqual(["arm", "arm", "arm", "fire"]);
		expect(stateRecords(before.key).at(-1)).toMatchObject({ op: "fire", id: "timer-2" });

		vi.advanceTimersByTime(0);
		expect(sentContents(after)).toEqual([expect.stringContaining("fired (after 10s): gap")]);

		await after.setTimer(60, "next");
		vi.advanceTimersByTime(50_000);
		expect(sentContents(after)).toEqual([
			expect.stringContaining("fired (after 10s): gap"),
			expect.stringContaining("Timer [timer-1] fired (after 60s): still-due"),
		]);
		// The id continues from the adopted counter, so the new timer cannot replace a live one.
		vi.advanceTimersByTime(10_000);
		expect(sentContents(after).at(-1)).toContain("Timer [timer-3] fired (after 60s): next");
	});

	it("(7) a second copy under a reload is standalone: no replay, no writes, no extra wake", async () => {
		const alpha = activation();
		const beta = activation(alpha.key);
		alpha.start("startup");
		await alpha.setTimer(600, "alpha");
		beta.start("startup");
		await beta.startHeartbeat(10, "beta");
		expect(stateOps(alpha.key)).toEqual(["arm"]);

		alpha.shutdown("reload");
		beta.shutdown("reload");
		const alphaAfter = activation(alpha.key);
		alphaAfter.start("reload");
		const betaAfter = activation(alpha.key);
		betaAfter.start("reload");

		expect(stateOps(alpha.key)).toEqual(["arm", "arm"]);
		vi.advanceTimersByTime(0);
		expect(sentContents(betaAfter)).toEqual([]);

		vi.advanceTimersByTime(600_000);
		expect(sentContents(alphaAfter)).toEqual([expect.stringContaining("fired (after 600s): alpha")]);
		expect(sentContents(betaAfter)).toEqual([]);
	});

	it("(8) the heartbeat resumes with one catch-up ping, stop persists, and a quit revives nothing", async () => {
		const before = activation();
		before.start("startup");
		await before.startHeartbeat(60, "hb");

		const after = restartAfter(before.key, 130_000);
		expect(sentContents(after)).toEqual(["💓 Heartbeat #1 resumed after pi was not running (every 60s): hb"]);
		expect(stateRecords(before.key).at(-1)).toMatchObject({
			op: "heartbeat",
			action: "start",
			heartbeat: { id: 1, tick: 1, lastTickAt: new Date(Date.now()).toISOString() },
		});

		vi.advanceTimersByTime(60_000);
		expect(sentContents(after).at(-1)).toContain("Heartbeat #1 tick 2 (every 60s): hb");

		await after.stopHeartbeat();
		expect(stateOps(before.key).at(-1)).toBe("heartbeat:stop");

		after.shutdown("quit");
		const gone = restart(before.key);
		vi.advanceTimersByTime(120_000);
		expect(sentContents(gone)).toEqual([]);
	});

	it("(9) a heartbeat boundary still ahead keeps the persisted last tick and its countdown", async () => {
		const before = activation();
		before.start("startup");
		await before.startHeartbeat(60, "hb");

		const after = restartAfter(before.key, 20_000);
		expect(sentContents(after)).toEqual([]);
		const claim = stateRecords(before.key).at(-1);
		expect(claim).toMatchObject({ op: "heartbeat", action: "start", heartbeat: { tick: 0 } });
		expect(claim?.op === "heartbeat" && claim.action === "start" ? claim.heartbeat.lastTickAt : "unexpected").toBeUndefined();
		expect(footer(after)).toBe("heartbeat 0:40");

		vi.advanceTimersByTime(39_000);
		expect(sentContents(after)).toEqual([]);
		// The first tick lands on the original boundary, not one interval after the restart.
		vi.advanceTimersByTime(1_000);
		expect(sentContents(after)).toEqual([expect.stringContaining("Heartbeat #1 tick 1 (every 60s): hb")]);
	});

	it("(10) /cancel-timer all writes a user clear", async () => {
		const act = activation();
		act.start("startup");
		await act.setTimer(60, "x");
		await act.startHeartbeat(30, "hb");
		await act.cancel("all");

		expect(stateOps(act.key).at(-1)).toBe("clear");
		expect(stateRecords(act.key).at(-1)).toMatchObject({ op: "clear", reason: "user" });
		vi.advanceTimersByTime(120_000);
		expect(sentContents(act)).toEqual([]);
	});

	it("(11) auto ids continue the restored counter", async () => {
		const before = activation();
		before.start("startup");
		await before.setTimer(3600, "seven", "timer-7");

		const after = restart(before.key);
		await after.setTimer(60, "next");
		vi.advanceTimersByTime(60_000);
		expect(sentContents(after)).toEqual([expect.stringContaining("Timer [timer-8] fired (after 60s): next")]);
	});

	it("(12) a re-armed timer is background work from session_start and reads its remaining time", async () => {
		const before = activation();
		before.start("startup");
		await before.setTimer(600, "x");

		const after = restartAfter(before.key, 100_000);
		expect(listedWork(before.key)).toEqual(["timer:timer-1"]);
		expect(footer(after)).toBe("timer-1 8:20");
		expect(stateOps(before.key).at(-1)).toBe("arm");
	});

	it("(13) a failing appendEntry does not break arming or firing", async () => {
		const act = activation();
		act.start("startup");
		act.appendEntry.mockImplementation(() => {
			throw new Error("disk full");
		});

		await act.setTimer(10, "still fires");
		vi.advanceTimersByTime(10_000);

		expect(sentContents(act)).toEqual([expect.stringContaining("fired (after 10s): still fires")]);
		expect(stateOps(act.key)).toEqual([]);
	});

	it("(14) main and child keys replay only their own journals", async () => {
		const main = activation();
		const child = activation();
		main.start("startup");
		child.start("startup");
		await main.setTimer(60, "main");
		await child.setTimer(30, "child");

		crash(main.key);
		crash(child.key);
		const mainAfter = activation(main.key);
		mainAfter.start("startup");
		const childAfter = activation(child.key);
		childAfter.start("startup");

		vi.advanceTimersByTime(60_000);
		expect(sentContents(mainAfter)).toEqual([expect.stringContaining("fired (after 60s): main")]);
		expect(sentContents(childAfter)).toEqual([expect.stringContaining("fired (after 30s): child")]);
	});

	it("(15) a fork writes its clear before the replay, so it inherits nothing", async () => {
		const parent = activation();
		parent.start("startup");
		await parent.setTimer(60, "parent-timer");
		await parent.startHeartbeat(10, "parent-hb");
		crash(parent.key);

		// `/fork` copies every non-label entry of the branch into a new file, custom entries included.
		const forkKey = randomUUID();
		journal(forkKey).push(...structuredClone(journal(parent.key)));
		expect(stateOps(forkKey)).toEqual(["arm", "heartbeat:start"]);

		const fork = activation(forkKey);
		fork.start("fork");
		expect(stateOps(forkKey)).toEqual(["arm", "heartbeat:start", "clear"]);
		expect(stateRecords(forkKey).at(-1)).toMatchObject({ op: "clear", reason: "fork" });

		vi.advanceTimersByTime(120_000);
		expect(sentContents(fork)).toEqual([]);
	});
});
