import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activation, resetSessions, sentContents } from "./reload-harness.js";

describe("reload survival: commands and ids after adoption", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		resetSessions();
		vi.useRealTimers();
	});

	it("(12) /cancel-timer all after adoption clears adopted timers, heartbeat and pending", async () => {
		const before = activation();
		before.start("startup");
		await before.setTimer(10, "t");
		await before.startHeartbeat(10, "hb");
		before.shutdown("reload");
		vi.advanceTimersByTime(15_000); // timer fires and tick 1 are queued in the gap

		const after = activation(before.key);
		after.start("reload");
		await after.cancel("all");
		vi.advanceTimersByTime(60_000);

		expect(after.sendMessage).not.toHaveBeenCalled();
	});

	it("(13) starting a heartbeat after adoption replaces the adopted one and ids continue", async () => {
		const before = activation();
		before.start("startup");
		await before.startHeartbeat(10, "first");
		before.shutdown("reload");

		const after = activation(before.key);
		after.start("reload");
		await after.startHeartbeat(10, "second");
		vi.advanceTimersByTime(10_000);

		expect(sentContents(after)).toEqual([expect.stringContaining("Heartbeat #2 tick 1")]);
		expect(before.sendMessage).not.toHaveBeenCalled();
	});

	it("(15) a user-supplied id equal to an adopted id replaces it", async () => {
		const before = activation();
		before.start("startup");
		await before.setTimer(60, "a", "job");
		before.shutdown("reload");

		const after = activation(before.key);
		after.start("reload");
		await after.setTimer(30, "b", "job");
		vi.advanceTimersByTime(60_000);

		expect(sentContents(after)).toEqual([expect.stringContaining("Timer [job] fired (after 30s): b")]);
	});
});
