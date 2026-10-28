import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activation, resetSessions, sentContents, sessionRegistry } from "./reload-harness.js";

describe("reload survival: lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		resetSessions();
		vi.useRealTimers();
	});

	it("(5) a non-reload shutdown clears timers and heartbeat and deletes the entry", async () => {
		const before = activation();
		before.start("startup");
		await before.setTimer(10, "t");
		await before.startHeartbeat(10, "hb");
		before.shutdown("quit");

		expect(sessionRegistry().has(before.key)).toBe(false);
		vi.advanceTimersByTime(60_000);
		expect(before.sendMessage).not.toHaveBeenCalled();

		const after = activation(before.key);
		after.start("startup");
		vi.advanceTimersByTime(60_000);
		expect(after.sendMessage).not.toHaveBeenCalled();
	});

	it("(6) two session keys in one process do not see each other's timers", async () => {
		const main = activation();
		const child = activation();
		main.start("startup");
		child.start("startup");
		await main.setTimer(10, "main");
		await child.setTimer(10, "child");

		vi.advanceTimersByTime(10_000);

		expect(sentContents(main)).toEqual([expect.stringContaining("fired (after 10s): main")]);
		expect(sentContents(child)).toEqual([expect.stringContaining("fired (after 10s): child")]);
	});

	it("(7) an entry with an unknown version is disposed and replaced, not adopted", async () => {
		const key = randomUUID();
		const dispose = vi.fn();
		sessionRegistry().set(key, { version: 99, dispose });

		const after = activation(key);
		after.start("reload");
		vi.advanceTimersByTime(10_000);

		expect(dispose).toHaveBeenCalledOnce();
		expect(sessionRegistry().get(key)?.version).toBe(1);
		expect(after.sendMessage).not.toHaveBeenCalled();
	});

	it("(8) a stale throw while attached drops the timer message and stops the heartbeat", async () => {
		const act = activation();
		act.start("startup");
		await act.setTimer(5, "t");
		await act.startHeartbeat(10, "hb");
		act.sendMessage.mockImplementation(() => {
			throw new Error("stale ctx");
		});

		vi.advanceTimersByTime(5_000); // timer fires, throws, dropped
		vi.advanceTimersByTime(5_000); // first heartbeat tick throws, heartbeat stops
		expect(act.sendMessage).toHaveBeenCalledTimes(2);

		act.sendMessage.mockClear();
		act.sendMessage.mockImplementation(() => undefined);
		vi.advanceTimersByTime(60_000);
		expect(act.sendMessage).not.toHaveBeenCalled();
	});

	it("(11) a detach with no adoption within 5 minutes retires the entry and stops the heartbeat", async () => {
		const before = activation();
		before.start("startup");
		await before.setTimer(600, "far");
		await before.startHeartbeat(10, "hb");
		before.shutdown("reload");

		vi.advanceTimersByTime(5 * 60_000 - 1);
		expect(sessionRegistry().has(before.key)).toBe(true);
		vi.advanceTimersByTime(1);
		expect(sessionRegistry().has(before.key)).toBe(false);

		const late = activation(before.key);
		late.start("reload");
		vi.advanceTimersByTime(60_000);
		expect(late.sendMessage).not.toHaveBeenCalled();
	});

	it("(14) a child session reloading does not touch the main session's timers", async () => {
		const main = activation();
		const child = activation();
		main.start("startup");
		child.start("startup");
		await main.setTimer(30, "main");
		await child.setTimer(10, "child");

		child.shutdown("reload");
		const childAfter = activation(child.key);
		childAfter.start("reload");
		vi.advanceTimersByTime(30_000);

		expect(sentContents(main)).toEqual([expect.stringContaining("fired (after 30s): main")]);
		expect(sentContents(childAfter)).toEqual([expect.stringContaining("fired (after 10s): child")]);
	});

	it("(18) a second activation on a live session key runs independently; neither loses timers", async () => {
		const first = activation();
		const second = activation(first.key);
		first.start("startup");
		await first.setTimer(10, "first");
		second.start("startup");
		await second.setTimer(10, "second");
		await first.setTimer(20, "first-late");

		vi.advanceTimersByTime(20_000);

		expect(sentContents(first)).toEqual([
			expect.stringContaining("fired (after 10s): first"),
			expect.stringContaining("fired (after 20s): first-late"),
		]);
		expect(sentContents(second)).toEqual([expect.stringContaining("fired (after 10s): second")]);
	});

	it("(19) a detached entry is replaced, not adopted, by a non-reload start on the same key", async () => {
		const before = activation();
		before.start("startup");
		await before.setTimer(10, "old");
		before.shutdown("reload");

		const fresh = activation(before.key);
		fresh.start("startup");
		await fresh.setTimer(5, "new");
		vi.advanceTimersByTime(10_000);

		expect(sentContents(fresh)).toEqual([expect.stringContaining("fired (after 5s): new")]);
		expect(before.sendMessage).not.toHaveBeenCalled();
	});

	it("(20) a second copy that reloads takes its own entry; the live copy's heartbeat keeps ticking", async () => {
		const alpha = activation();
		const beta = activation(alpha.key);
		alpha.start("startup");
		beta.start("startup");
		await alpha.startHeartbeat(10, "alpha-hb");
		await beta.startHeartbeat(10, "beta-hb");
		alpha.shutdown("reload");
		beta.shutdown("reload");
		const alphaAfter = activation(alpha.key);
		alphaAfter.start("reload");
		const betaAfter = activation(alpha.key);
		betaAfter.start("reload");
		await betaAfter.startHeartbeat(10, "gamma-hb");
		vi.advanceTimersByTime(20_000);
		expect(sentContents(alphaAfter)).toEqual([
			expect.stringContaining("tick 1 (every 10s): alpha-hb"),
			expect.stringContaining("tick 2 (every 10s): alpha-hb"),
		]);
		expect(sentContents(betaAfter)).toEqual([
			expect.stringContaining("tick 1 (every 10s): gamma-hb"),
			expect.stringContaining("tick 2 (every 10s): gamma-hb"),
		]);
		// The standalone copy is not in the session registry: resetSessions() must shut it down too, or its
		// heartbeat interval outlives the test (three fake timers before the harness fix).
		resetSessions();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("(21) a heartbeat stopped while detached drops its queued gap tick; adoption delivers nothing stale", async () => {
		const before = activation();
		before.start("startup");
		await before.startHeartbeat(10, "old");
		before.shutdown("reload");
		vi.advanceTimersByTime(10_000); // tick 1 is queued in the gap
		await before.stopHeartbeat();
		const after = activation(before.key);
		after.start("reload");
		vi.advanceTimersByTime(60_000);
		expect(sentContents(after)).toEqual([]);
	});
});
