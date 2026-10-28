import { BACKGROUND_WORK_DISPLAY_KEY, listBackgroundWorkDisplayProviders, snapshotBackgroundWork } from "@cad0p/pi-background-work";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeArmedWork } from "../../src/display-provider.js";
import { registry } from "../../src/timer-manager.js";
import { type Activation, activation, resetBackgroundWork, resetSessions } from "./reload-harness.js";

const SESSIONS = Symbol.for("pi-heartbeat.sessions");
const PROVIDER = "pi-heartbeat";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The footer segment this activation's items produce, as of `nowMs`. */
function segment(act: Activation, nowMs: number = Date.now()): string | null {
	const items = snapshotBackgroundWork([act.key], nowMs).items;
	return describeArmedWork(items, { sessionId: act.key, sessionIds: [act.key], nowMs });
}

function displayNamed(): unknown {
	return listBackgroundWorkDisplayProviders().find((provider) => provider.name === PROVIDER);
}

describe("background work: the footer segment", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-28T12:00:00.000Z"));
		resetBackgroundWork();
	});

	afterEach(() => {
		resetSessions();
		vi.useRealTimers();
	});

	it("(1) one timer reads its remaining time", async () => {
		const act = activation();
		act.start("startup");
		await act.setTimer(42, "x");

		expect(segment(act)).toBe("timer-1 0:42");
	});

	it("(2) several timers lead with the count", async () => {
		const act = activation();
		act.start("startup");
		await act.setTimer(42, "x");
		await act.setTimer(65, "y");

		expect(segment(act)).toBe("2 timers: timer-1 0:42, timer-2 1:05");
	});

	it("(3) under a minute reads 0:SS, a minute or more M:SS", async () => {
		const act = activation();
		act.start("startup");
		await act.setTimer(59, "x", "a");
		await act.setTimer(60, "y", "b");
		await act.setTimer(125, "z", "c");

		expect(segment(act)).toBe("3 timers: a 0:59, b 1:00, c 2:05");
	});

	it("(4) a timer past its deadline reads 0:00", async () => {
		const act = activation();
		act.start("startup");
		await act.setTimer(10, "x", "soon");
		const timer = registry().get(act.key)?.timers.get("soon");
		if (!timer) {
			throw new Error("no timer");
		}
		timer.createdAt = new Date(Date.now() - 30_000).toISOString();

		expect(segment(act)).toBe("soon 0:00");
	});

	it("(5) the heartbeat reads the time to its next tick", async () => {
		const act = activation();
		act.start("startup");
		await act.startHeartbeat(60, "watch");

		expect(segment(act)).toBe("heartbeat 1:00");
		vi.advanceTimersByTime(15_000);
		expect(segment(act)).toBe("heartbeat 0:45");
		// A tick re-arms the countdown rather than showing elapsed time.
		vi.advanceTimersByTime(45_000);
		expect(segment(act)).toBe("heartbeat 1:00");
	});

	it("(6) a heartbeat and timers are joined with a middle dot", async () => {
		const act = activation();
		act.start("startup");
		await act.startHeartbeat(270, "watch");
		await act.setTimer(42, "x");
		await act.setTimer(65, "y");

		// 50 graphemes would exceed the footer's limit: the count survives, the last detail does not.
		expect(segment(act)).toBe("heartbeat 4:30 · 2 timers: timer-1 0:42…");
	});

	it("(7) a queued timer wake folds into its timer instead of adding an entry", async () => {
		const act = activation();
		act.start("startup");
		await act.setTimer(10, "gap");
		act.shutdown("reload");
		vi.advanceTimersByTime(10_000);

		expect(snapshotBackgroundWork([act.key]).items.map((item) => item.id)).toEqual(["pending:1"]);
		expect(segment(act)).toBe("timer-1 0:00");
	});

	it("(8) a queued heartbeat tick folds into the heartbeat instead of adding an entry", async () => {
		const act = activation();
		act.start("startup");
		await act.startHeartbeat(10, "watch");
		act.shutdown("reload");
		vi.advanceTimersByTime(10_000);

		expect(snapshotBackgroundWork([act.key]).items.map((item) => item.id)).toEqual(["heartbeat:1", "pending:1"]);
		expect(segment(act)).toBe("heartbeat 0:10");
	});

	it("(9) a wake with no owner reads wake queued", async () => {
		const act = activation();
		act.start("startup");
		const entry = registry().get(act.key);
		if (!entry) {
			throw new Error("no entry");
		}
		entry.pending.push({ message: { customType: "x", content: "x", display: true, details: {} } });

		expect(segment(act)).toBe("wake queued");
	});

	it("(9b) a wake whose heartbeat is gone reads wake queued", async () => {
		const act = activation();
		act.start("startup");
		const entry = registry().get(act.key);
		if (!entry) {
			throw new Error("no entry");
		}
		entry.pending.push({
			heartbeatId: 99,
			message: { customType: "x", content: "x", display: true, details: { type: "heartbeat", heartbeatId: 99 } },
		});

		expect(segment(act)).toBe("wake queued");
	});

	it("(10) nothing armed contributes no segment", () => {
		const act = activation();
		act.start("startup");

		expect(segment(act)).toBeNull();
	});

	it("(11) an unreadable registry contributes no segment", () => {
		Reflect.set(globalThis, SESSIONS, 42);
		try {
			expect(() => describeArmedWork([], { sessionId: "x", sessionIds: ["x"], nowMs: Date.now() })).not.toThrow();
			expect(describeArmedWork([], { sessionId: "x", sessionIds: ["x"], nowMs: Date.now() })).toBeNull();
		} finally {
			Reflect.deleteProperty(globalThis, SESSIONS);
		}
	});

	it("(12) items for another session are ignored", async () => {
		const own = activation();
		const other = activation();
		own.start("startup");
		other.start("startup");
		await own.setTimer(42, "x", "build");
		await other.setTimer(60, "y", "deploy");

		const items = snapshotBackgroundWork([own.key, other.key]).items;
		expect(describeArmedWork(items, { sessionId: own.key, sessionIds: [own.key], nowMs: Date.now() })).toBe("build 0:42");
	});

	it("(13) three timers never exceed the footer's 48-grapheme segment", async () => {
		const act = activation();
		act.start("startup");
		await act.setTimer(42, "x");
		await act.setTimer(65, "y");
		await act.setTimer(90, "z");

		const text = segment(act);
		if (text === null) {
			throw new Error("no segment");
		}
		expect([...segmenter.segment(text)].length).toBeLessThanOrEqual(48);
		expect(text).toBe("3 timers: timer-1 0:42, timer-2 1:05…");
	});
});

describe("background work: display registration", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetBackgroundWork();
		Reflect.deleteProperty(globalThis, Symbol.for(BACKGROUND_WORK_DISPLAY_KEY));
	});

	afterEach(() => {
		resetSessions();
		Reflect.deleteProperty(globalThis, Symbol.for(BACKGROUND_WORK_DISPLAY_KEY));
		vi.useRealTimers();
	});

	it("(14) startup registers the display once; reload replaces it; quit does not remove it", () => {
		const first = activation();
		first.start("startup");
		const registered = displayNamed();
		expect(registered).toBeDefined();

		const second = activation();
		second.start("startup");
		expect(displayNamed()).toBe(registered);

		first.shutdown("quit");
		expect(displayNamed()).toBe(registered);

		second.shutdown("reload");
		const reloaded = activation(second.key);
		reloaded.start("reload");
		expect(displayNamed()).not.toBe(registered);
	});

	it("(15) a malformed display registry does not stop session binding", async () => {
		Reflect.set(globalThis, Symbol.for(BACKGROUND_WORK_DISPLAY_KEY), {
			version: 1,
			providers: new Map([["foreign", { name: "other" }]]),
		});
		expect(() => listBackgroundWorkDisplayProviders()).toThrow();
		const act = activation();

		expect(() => act.start("startup")).not.toThrow();
		expect(registry().has(act.key)).toBe(true);
		// The public list throws in this state, so read the raw registry to see pi-heartbeat's registration.
		const slot = Reflect.get(globalThis, Symbol.for(BACKGROUND_WORK_DISPLAY_KEY)) as { providers: Map<string, unknown> };
		expect(slot.providers.has(PROVIDER)).toBe(true);

		await act.setTimer(60, "x");
		expect(segment(act)).toBe("timer-1 1:00");
	});
});
