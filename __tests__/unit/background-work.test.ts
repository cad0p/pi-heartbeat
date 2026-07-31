import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TimerManager } from "../../src/timer-manager.js";
import {
	acquireBackgroundWork,
	getBackgroundWorkRegistry,
	type BackgroundWorkRegistry,
} from "../../src/background-work.js";

const REGISTRY_KEY = Symbol.for("pi:background-work");

function createMockPi() {
	return {
		sendMessage: vi.fn(),
	} as any;
}

function resetRegistry(): void {
	delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
}

describe("background-work registry", () => {
	let registry: BackgroundWorkRegistry;

	beforeEach(() => {
		resetRegistry();
		registry = getBackgroundWorkRegistry();
	});

	afterEach(() => {
		resetRegistry();
	});

	it("is shared via globalThis behind Symbol.for", () => {
		expect((globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]).toBeDefined();
		expect(getBackgroundWorkRegistry()).toBe(registry);
	});

	it("acquire increments pending, release decrements", () => {
		expect(registry.pending()).toBe(0);
		const release = acquireBackgroundWork("test");
		expect(registry.pending()).toBe(1);
		release();
		expect(registry.pending()).toBe(0);
	});

	it("tracks multiple tokens independently", () => {
		const r1 = acquireBackgroundWork("a");
		const r2 = acquireBackgroundWork("b");
		expect(registry.pending()).toBe(2);
		r1();
		expect(registry.pending()).toBe(1);
		r2();
		expect(registry.pending()).toBe(0);
	});

	it("double release is a no-op", () => {
		const release = acquireBackgroundWork("test");
		release();
		release();
		expect(registry.pending()).toBe(0);
	});

	it("onDrain fires only when the last token is released", () => {
		const listener = vi.fn();
		registry.onDrain(listener);

		const r1 = acquireBackgroundWork("a");
		const r2 = acquireBackgroundWork("b");
		r1();
		expect(listener).not.toHaveBeenCalled();
		r2();
		expect(listener).toHaveBeenCalledOnce();
	});

	it("onDrain unsubscribe prevents the call", () => {
		const listener = vi.fn();
		const unsubscribe = registry.onDrain(listener);
		unsubscribe();

		const release = acquireBackgroundWork("a");
		release();
		expect(listener).not.toHaveBeenCalled();
	});
});

describe("TimerManager background-work tokens", () => {
	let manager: TimerManager;
	let mockPi: ReturnType<typeof createMockPi>;
	let registry: BackgroundWorkRegistry;

	beforeEach(() => {
		resetRegistry();
		registry = getBackgroundWorkRegistry();
		vi.useFakeTimers();
		mockPi = createMockPi();
		manager = new TimerManager(mockPi);
	});

	afterEach(() => {
		manager.clearAll();
		vi.useRealTimers();
		resetRegistry();
	});

	it("setTimer advertises pending work until the timer fires", () => {
		manager.setTimer(10, "check build");
		expect(registry.pending()).toBe(1);

		vi.advanceTimersByTime(10_000);
		expect(mockPi.sendMessage).toHaveBeenCalledOnce();
		expect(registry.pending()).toBe(0);
	});

	it("cancelTimer releases the token without firing", () => {
		const id = manager.setTimer(10, "check build");
		expect(registry.pending()).toBe(1);

		manager.cancelTimer(id);
		expect(registry.pending()).toBe(0);
		expect(mockPi.sendMessage).not.toHaveBeenCalled();
	});

	it("replacing a timer with the same ID releases the old token", () => {
		manager.setTimer(10, "old", "build-check");
		manager.setTimer(20, "new", "build-check");
		expect(registry.pending()).toBe(1);

		vi.advanceTimersByTime(20_000);
		expect(registry.pending()).toBe(0);
	});

	it("multiple timers each hold a token", () => {
		manager.setTimer(10, "first");
		manager.setTimer(20, "second");
		expect(registry.pending()).toBe(2);

		vi.advanceTimersByTime(10_000);
		expect(registry.pending()).toBe(1);
		vi.advanceTimersByTime(10_000);
		expect(registry.pending()).toBe(0);
	});

	it("heartbeat holds a token for its whole lifetime", () => {
		manager.startHeartbeat(30, "check deploy");
		expect(registry.pending()).toBe(1);

		vi.advanceTimersByTime(90_000);
		expect(mockPi.sendMessage).toHaveBeenCalledTimes(3);
		expect(registry.pending()).toBe(1);

		manager.stopHeartbeat();
		expect(registry.pending()).toBe(0);
	});

	it("starting a new heartbeat replaces the old token", () => {
		manager.startHeartbeat(30, "first");
		manager.startHeartbeat(60, "second");
		expect(registry.pending()).toBe(1);

		manager.stopHeartbeat();
		expect(registry.pending()).toBe(0);
	});

	it("heartbeat stopping on stale ctx also releases the token", () => {
		mockPi.sendMessage.mockImplementation(() => {
			throw new Error("stale ctx");
		});
		manager.startHeartbeat(30, "check deploy");
		expect(registry.pending()).toBe(1);

		vi.advanceTimersByTime(30_000);
		expect(registry.pending()).toBe(0);
		expect(manager.isHeartbeatActive()).toBe(false);
	});

	it("timer firing on stale ctx still releases the token", () => {
		mockPi.sendMessage.mockImplementation(() => {
			throw new Error("stale ctx");
		});
		manager.setTimer(10, "check build");
		expect(registry.pending()).toBe(1);

		vi.advanceTimersByTime(10_000);
		expect(registry.pending()).toBe(0);
	});

	it("clearAll releases all tokens", () => {
		manager.setTimer(10, "first");
		manager.setTimer(20, "second");
		manager.startHeartbeat(30, "deploy");
		expect(registry.pending()).toBe(3);

		manager.clearAll();
		expect(registry.pending()).toBe(0);
	});
});
