import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activation, resetSessions, sentContents } from "./reload-harness.js";

describe("reload survival: adoption", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		resetSessions();
		vi.useRealTimers();
	});

	it("(1) a timer armed before reload fires into the reloaded activation", async () => {
		const before = activation();
		before.start("startup");
		await before.setTimer(10, "x");
		before.shutdown("reload");
		const after = activation(before.key);
		after.start("reload");

		vi.advanceTimersByTime(10_000);

		expect(sentContents(after)).toEqual([expect.stringContaining("fired (after 10s): x")]);
		expect(before.sendMessage).not.toHaveBeenCalled();
	});

	it("(2) ids continue after reload and a new timer does not cancel an adopted one", async () => {
		const before = activation();
		before.start("startup");
		await before.setTimer(60, "a");
		before.shutdown("reload");
		const after = activation(before.key);
		after.start("reload");
		await after.setTimer(60, "b");

		vi.advanceTimersByTime(60_000);

		expect(sentContents(after)).toEqual([
			expect.stringContaining("Timer [timer-1] fired"),
			expect.stringContaining("Timer [timer-2] fired"),
		]);
	});

	it("(3) a timer that fires in the reload gap is delivered once, on adoption", async () => {
		const before = activation();
		before.start("startup");
		await before.setTimer(10, "gap");
		before.shutdown("reload");
		vi.advanceTimersByTime(10_000);
		const after = activation(before.key);
		after.start("reload");

		vi.advanceTimersByTime(0);
		vi.advanceTimersByTime(60_000);

		expect(sentContents(after)).toEqual([expect.stringContaining("fired (after 10s): gap")]);
	});

	it("(4) the heartbeat keeps ticking into the reloaded activation; a gap tick is delivered once", async () => {
		const before = activation();
		before.start("startup");
		await before.startHeartbeat(10, "hb");
		before.shutdown("reload");
		vi.advanceTimersByTime(25_000); // ticks 1 and 2 land in the gap, only tick 2 is kept
		const after = activation(before.key);
		after.start("reload");

		vi.advanceTimersByTime(0);
		vi.advanceTimersByTime(10_000); // tick 3 on the live interval

		expect(sentContents(after)).toEqual([
			expect.stringContaining("tick 2"),
			expect.stringContaining("tick 3"),
		]);
		expect(before.sendMessage).not.toHaveBeenCalled();
	});

	it("(9) shutdown unsets delivery before the old pi is invalidated", async () => {
		const before = activation();
		before.start("startup");
		await before.setTimer(10, "late");
		before.sendMessage.mockImplementation(() => {
			throw new Error("stale ctx");
		});
		before.shutdown("reload");

		vi.advanceTimersByTime(10_000);

		expect(before.sendMessage).not.toHaveBeenCalled();
		const after = activation(before.key);
		after.start("reload");
		vi.advanceTimersByTime(0);
		expect(sentContents(after)).toEqual([expect.stringContaining("fired (after 10s): late")]);
	});

	it("(10) adoption flush is deferred: nothing is sent inside session_start, once after", async () => {
		const before = activation();
		before.start("startup");
		await before.setTimer(10, "gap");
		before.shutdown("reload");
		vi.advanceTimersByTime(10_000);
		const after = activation(before.key);

		after.start("reload");
		expect(after.sendMessage).not.toHaveBeenCalled();

		vi.advanceTimersByTime(0);
		expect(after.sendMessage).toHaveBeenCalledOnce();
	});
});
