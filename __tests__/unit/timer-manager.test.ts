import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TimerManager } from "../../src/timer-manager.js";

// Minimal mock of ExtensionAPI — just sendMessage
function createMockPi() {
	return {
		sendMessage: vi.fn(),
	} as any;
}

describe("TimerManager", () => {
	let manager: TimerManager;
	let mockPi: ReturnType<typeof createMockPi>;

	beforeEach(() => {
		vi.useFakeTimers();
		mockPi = createMockPi();
		manager = new TimerManager(mockPi);
	});

	afterEach(() => {
		manager.clearAll();
		vi.useRealTimers();
	});

	describe("one-shot timers", () => {
		it("sets a timer and fires after delay", () => {
			manager.setTimer(10, "check build");

			expect(mockPi.sendMessage).not.toHaveBeenCalled();
			vi.advanceTimersByTime(10_000);
			expect(mockPi.sendMessage).toHaveBeenCalledOnce();

			const [msg, opts] = mockPi.sendMessage.mock.calls[0];
			expect(msg.customType).toBe("heartbeat-timer");
			expect(msg.content).toContain("check build");
			expect(msg.display).toBe(true);
			expect(opts.triggerTurn).toBe(true);
		});

		it("auto-generates timer IDs", () => {
			const id1 = manager.setTimer(5, "first");
			const id2 = manager.setTimer(5, "second");
			expect(id1).not.toBe(id2);
			expect(id1).toMatch(/^timer-\d+$/);
		});

		it("uses custom ID when provided", () => {
			const id = manager.setTimer(5, "test", "my-timer");
			expect(id).toBe("my-timer");
		});

		it("replaces timer with same ID", () => {
			manager.setTimer(10, "old", "build-check");
			manager.setTimer(20, "new", "build-check");

			vi.advanceTimersByTime(10_000);
			expect(mockPi.sendMessage).not.toHaveBeenCalled();

			vi.advanceTimersByTime(10_000);
			expect(mockPi.sendMessage).toHaveBeenCalledOnce();
			expect(mockPi.sendMessage.mock.calls[0][0].content).toContain("new");
		});

		it("cancels a timer by ID", () => {
			manager.setTimer(10, "test", "cancel-me");
			expect(manager.cancelTimer("cancel-me")).toBe(true);

			vi.advanceTimersByTime(10_000);
			expect(mockPi.sendMessage).not.toHaveBeenCalled();
		});

		it("returns false for non-existent timer cancellation", () => {
			expect(manager.cancelTimer("nope")).toBe(false);
		});

		it("lists active timer IDs", () => {
			manager.setTimer(10, "a", "t1");
			manager.setTimer(20, "b", "t2");
			expect(manager.getActiveTimerIds()).toEqual(["t1", "t2"]);

			vi.advanceTimersByTime(10_000);
			expect(manager.getActiveTimerIds()).toEqual(["t2"]);
		});

		it("supports multiple concurrent timers", () => {
			manager.setTimer(5, "first");
			manager.setTimer(10, "second");
			manager.setTimer(15, "third");

			vi.advanceTimersByTime(5_000);
			expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(5_000);
			expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);

			vi.advanceTimersByTime(5_000);
			expect(mockPi.sendMessage).toHaveBeenCalledTimes(3);
		});
	});

	describe("heartbeat", () => {
		it("fires periodically", () => {
			manager.startHeartbeat(10, "status check");

			vi.advanceTimersByTime(10_000);
			expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(10_000);
			expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);

			const [msg] = mockPi.sendMessage.mock.calls[0];
			expect(msg.customType).toBe("heartbeat-ping");
			expect(msg.content).toContain("status check");
			expect(msg.details.tick).toBe(1);
		});

		it("tracks tick count", () => {
			manager.startHeartbeat(5, "test");

			vi.advanceTimersByTime(15_000);

			expect(mockPi.sendMessage.mock.calls[2][0].details.tick).toBe(3);
		});

		it("stops when requested", () => {
			manager.startHeartbeat(5, "test");

			vi.advanceTimersByTime(10_000);
			expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);

			const stopped = manager.stopHeartbeat();
			expect(stopped).toBeDefined();
			expect(stopped!.tick).toBe(2);

			vi.advanceTimersByTime(10_000);
			expect(mockPi.sendMessage).toHaveBeenCalledTimes(2); // no more
		});

		it("starting a new heartbeat stops the previous", () => {
			manager.startHeartbeat(5, "old");

			vi.advanceTimersByTime(5_000);
			expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
			expect(mockPi.sendMessage.mock.calls[0][0].content).toContain("old");

			manager.startHeartbeat(10, "new");

			vi.advanceTimersByTime(5_000);
			expect(mockPi.sendMessage).toHaveBeenCalledTimes(1); // old stopped, new not yet

			vi.advanceTimersByTime(5_000);
			expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);
			expect(mockPi.sendMessage.mock.calls[1][0].content).toContain("new");
		});

		it("reports status correctly", () => {
			expect(manager.isHeartbeatActive()).toBe(false);
			expect(manager.getHeartbeatState()).toBeUndefined();

			manager.startHeartbeat(30, "deploy");
			expect(manager.isHeartbeatActive()).toBe(true);

			const state = manager.getHeartbeatState();
			expect(state).toBeDefined();
			expect(state!.intervalSeconds).toBe(30);
			expect(state!.message).toBe("deploy");

			manager.stopHeartbeat();
			expect(manager.isHeartbeatActive()).toBe(false);
		});

		it("returns undefined when stopping with no heartbeat", () => {
			expect(manager.stopHeartbeat()).toBeUndefined();
		});
	});

	describe("clearAll", () => {
		it("clears all timers and heartbeat", () => {
			manager.setTimer(10, "a", "t1");
			manager.setTimer(20, "b", "t2");
			manager.startHeartbeat(5, "hb");

			manager.clearAll();

			expect(manager.getActiveTimerIds()).toEqual([]);
			expect(manager.isHeartbeatActive()).toBe(false);

			vi.advanceTimersByTime(20_000);
			expect(mockPi.sendMessage).not.toHaveBeenCalled();
		});
	});
});
