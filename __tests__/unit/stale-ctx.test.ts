import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TimerManager } from "../../src/timer-manager.js";

/**
 * Stale extension ctx crash tests.
 *
 * When a pi session is replaced (newSession/fork/switchSession/reload), the
 * extension runtime invalidates the captured `pi` ctx. Any subsequent call to
 * `pi.sendMessage()` throws a stale-ctx error. If that throw happens inside a
 * `setTimeout`/`setInterval` callback — which is how TimerManager fires — it
 * becomes an uncaughtException and kills the pi process.
 *
 * These tests verify that TimerManager handles a throwing `sendMessage`
 * gracefully: no throw escapes the timer callback, and the timer/heartbeat
 * self-cancels so it doesn't keep retrying on a dead ctx.
 */

// The exact error message thrown by pi's extension runtime (loader.js assertActive)
// when the ctx has been invalidated by session replacement.
const STALE_CTX_MESSAGE =
	"This extension ctx is stale after session replacement or reload. " +
	"Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), " +
	"ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, " +
	"move post-replacement work into withSession and use the ctx passed to withSession. " +
	"For reload, do not use the old ctx after await ctx.reload().";

function createStaleMockPi() {
	return {
		sendMessage: vi.fn(() => {
			throw new Error(STALE_CTX_MESSAGE);
		}),
	} as any;
}

describe("TimerManager stale-ctx resilience", () => {
	let manager: TimerManager;
	let mockPi: ReturnType<typeof createStaleMockPi>;

	beforeEach(() => {
		vi.useFakeTimers();
		mockPi = createStaleMockPi();
		manager = new TimerManager(mockPi);
	});

	afterEach(() => {
		manager.clearAll();
		vi.useRealTimers();
	});

	describe("one-shot timer", () => {
		it("does not throw when sendMessage rejects with stale-ctx error", () => {
			manager.setTimer(10, "check CI run");

			// Before the fix: sendMessage throws inside the setTimeout callback,
			// which propagates out of advanceTimersByTime as an uncaught error.
			// After the fix: the callback catches the error and self-cancels.
			expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
		});

		it("still attempts to send (timer fires, not silently skipped)", () => {
			manager.setTimer(10, "check CI run");

			vi.advanceTimersByTime(10_000);

			expect(mockPi.sendMessage).toHaveBeenCalledOnce();
		});

		it("removes the timer from active set after firing", () => {
			const id = manager.setTimer(10, "check CI run");

			vi.advanceTimersByTime(10_000);

			expect(manager.getActiveTimerIds()).not.toContain(id);
		});
	});

	describe("heartbeat (periodic)", () => {
		it("does not throw when sendMessage rejects with stale-ctx error", () => {
			manager.startHeartbeat(10, "deploy status");

			expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
		});

		it("self-cancels the interval after a stale-ctx error (no zombie interval)", () => {
			manager.startHeartbeat(10, "deploy status");

			vi.advanceTimersByTime(10_000);

			// Before the fix: the interval keeps firing every 10s, throwing each
			// time. After the fix: the first stale-ctx error stops the interval.
			expect(manager.isHeartbeatActive()).toBe(false);
		});

		it("does not keep throwing on subsequent ticks", () => {
			manager.startHeartbeat(10, "deploy status");

			// Advance past multiple ticks. Before the fix, each tick throws.
			// After the fix, the interval was stopped after the first error.
			expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();

			// sendMessage should have been called exactly once (first tick),
			// not 3 times (which would mean the zombie interval kept firing).
			expect(mockPi.sendMessage).toHaveBeenCalledOnce();
		});
	});
});
