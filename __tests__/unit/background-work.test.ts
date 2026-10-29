import { snapshotBackgroundWork } from "@cad0p/pi-background-work";
import { Compile } from "typebox/compile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../src/timer-manager.js";
import { activation, listedWork, resetBackgroundWork, resetSessions, sentContents } from "./reload-harness.js";

describe("background work: what the provider reports", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetBackgroundWork();
	});

	afterEach(() => {
		resetSessions();
		vi.useRealTimers();
	});

	it("(1) an armed timer is listed for its session under the uuid alone and under [file, uuid]", async () => {
		const act = activation();
		act.start("startup");
		await act.setTimer(60, "x", "build");

		const file = `/home/pier/.pi/agent/sessions/${act.key}.jsonl`;
		expect(listedWork(act.key)).toEqual(["timer:build"]);
		expect(snapshotBackgroundWork([file, act.key]).items.map((item) => item.id)).toEqual(["timer:build"]);
	});

	it("(2) a session's work is not listed for another session", async () => {
		const act = activation();
		const other = activation();
		act.start("startup");
		other.start("startup");
		await act.setTimer(60, "x", "build");
		await other.setTimer(60, "y", "deploy");

		expect(listedWork(act.key)).toEqual(["timer:build"]);
		expect(listedWork(other.key)).toEqual(["timer:deploy"]);
	});

	it("(3) the heartbeat is listed while running and gone after stop", async () => {
		const act = activation();
		act.start("startup");
		await act.startHeartbeat(60, "watch");
		expect(listedWork(act.key)).toEqual(["heartbeat:1"]);

		await act.stopHeartbeat();
		expect(listedWork(act.key)).toEqual([]);
	});

	it("(4) a timer fired in the reload gap is listed as pending until adoption flushes it", async () => {
		const before = activation();
		before.start("startup");
		await before.setTimer(10, "gap");
		before.shutdown("reload");
		vi.advanceTimersByTime(10_000);
		expect(listedWork(before.key)).toEqual(["pending:1"]);

		const after = activation(before.key);
		after.start("reload");
		vi.advanceTimersByTime(0);

		expect(listedWork(before.key)).toEqual([]);
		expect(sentContents(after)).toEqual([expect.stringContaining("fired (after 10s): gap")]);
	});

	it("(4b) a legacy pending entry without seq gets its own id and cannot collide with a seq id", async () => {
		const before = activation();
		before.start("startup");
		await before.setTimer(10, "gap");
		before.shutdown("reload");
		vi.advanceTimersByTime(10_000);

		const entry = registry().get(before.key);
		const queued = entry?.pending[0];
		if (!entry || !queued) {
			throw new Error("no pending entry");
		}
		const legacy = { ...queued };
		Reflect.deleteProperty(legacy, "seq");
		entry.pending.push(legacy);

		expect(snapshotBackgroundWork([before.key]).items.map((item) => item.id)).toEqual(["pending:1", "pending:legacy-1"]);
	});

	it("(5) a timer that fired is no longer listed", async () => {
		const act = activation();
		act.start("startup");
		await act.setTimer(10, "x", "soon");
		expect(listedWork(act.key)).toEqual(["timer:soon"]);

		vi.advanceTimersByTime(10_000);

		expect(listedWork(act.key)).toEqual([]);
	});

	it("(8) a user timer named heartbeat:1 does not collide with the heartbeat item", async () => {
		const act = activation();
		act.start("startup");
		await act.setTimer(60, "a", "heartbeat:1");
		await act.startHeartbeat(60, "b");

		expect(listedWork(act.key).sort()).toEqual(["heartbeat:1", "timer:heartbeat:1"]);
	});

	it("(9) the timer tool schema rejects bad ids; a bad id that reaches the manager is skipped, not fatal", async () => {
		const act = activation();
		act.start("startup");
		// The host compiles tool schemas with typebox 1.x, so validate with the same compiler rather than with
		// typebox 0.34's Value.Check, which counts UTF-16 units and would not match the host's answer.
		const schema = Compile(act.toolSchema("timer"));
		const accepts = (id: string) => schema.Check({ seconds: 10, message: "x", id });

		expect(accepts("build")).toBe(true);
		expect(accepts("x".repeat(200))).toBe(true);
		expect(accepts(" build")).toBe(false);
		expect(accepts("build ")).toBe(false);
		expect(accepts("a\u0007b")).toBe(false);
		expect(accepts("x".repeat(201))).toBe(false);
		expect(accepts("a\u2028b")).toBe(true);
		expect(accepts("a\u2028b ")).toBe(false);

		// The pinned typebox 1.3.7 counts maxLength in grapheme clusters: 200 astral characters are 400 UTF-16
		// units and still pass, 201 do not, and 251 units in 126 graphemes pass too. The manager's 250-unit
		// refusal is therefore the layer that keeps "timer:<id>" inside the package's 256-unit budget.
		expect(accepts("\u{1F680}".repeat(200))).toBe(true);
		expect(accepts("\u{1F680}".repeat(201))).toBe(false);
		expect(accepts("\u{1F680}".repeat(125) + "b")).toBe(true);

		// 200 "e" + U+0301 pairs are 200 grapheme clusters but 400 code points, so this is the case that shows
		// which measure the installed compiler applies. The astral cases above cannot: 200 astral characters
		// are 200 clusters and 200 code points. 1.3.7 counts clusters and accepts this; a compiler that counts
		// code points (typebox 1.3.37+) rejects it, which is why the manager's refusal names no measure.
		expect(accepts("e\u0301".repeat(200))).toBe(true);

		// The harness calls execute directly, bypassing the schema: the provider must still skip the bad id.
		await act.setTimer(10, "x", " bad");
		await act.setTimer(60, "ok", "good");
		expect(listedWork(act.key)).toEqual(["timer:good"]);
	});

	it("(9c) the longest ids the manager accepts fit the package's 256-unit item budget", async () => {
		const act = activation();
		act.start("startup");
		// 6 + 250 = 256 UTF-16 units: exactly the package's cap, so these must list, not be skipped.
		await act.setTimer(60, "astral", "\u{1F680}".repeat(125));
		await act.setTimer(60, "bmp", "b".repeat(200));
		expect(listedWork(act.key).sort()).toEqual(["timer:" + "b".repeat(200), "timer:" + "\u{1F680}".repeat(125)]);

		// The snapshot validates, so it would have thrown if an item passed 256 units. Asserting that the longest
		// rendered item sits exactly on the cap pins the consumer's boundary against the manager's.
		const items = snapshotBackgroundWork([act.key]).items;
		expect(Math.max(...items.map((item) => item.id.length))).toBe(256);
	});

	it("(9e) the provider skips a 251-unit id, one unit past the item budget, on its own", async () => {
		const act = activation();
		act.start("startup");
		// setTimer refuses this id, so write it into the entry directly: the provider's own bound has to hold,
		// or the 257-unit item would make every snapshot throw instead of just hiding this timer.
		const entry = registry().get(act.key);
		if (!entry) {
			throw new Error("no session entry");
		}
		const id = "\u{1F680}".repeat(125) + "b";
		expect(id.length).toBe(251);
		entry.timers.set(id, {
			timeout: setTimeout(() => {}, 0),
			seconds: 60,
			message: "unreachable",
			createdAt: new Date().toISOString(),
		});
		await act.setTimer(60, "ok", "good");

		expect(() => listedWork(act.key)).not.toThrow();
		expect(listedWork(act.key)).toEqual(["timer:good"]);
	});

	it("(9d) an astral id past the package's unit budget is refused before it is armed", async () => {
		const act = activation();
		act.start("startup");
		// The host's validator counts grapheme clusters, so 200 astral characters pass the schema (400 UTF-16
		// units). The manager therefore enforces the unit budget itself, whatever layer let the id through.
		await expect(act.setTimer(10, "x", "\u{1F680}".repeat(200))).rejects.toThrow(/at most 250 are allowed/);
		expect(listedWork(act.key)).toEqual([]);
	});

	it("(9b) an id the schema would reject, held by the manager, is skipped and does not make the snapshot throw", async () => {
		const act = activation();
		act.start("startup");
		// Bypasses the schema. The old pattern accepted this id, and the package's trim check rejects it.
		await act.setTimer(10, "x", "a\u2028b ");
		await act.setTimer(60, "ok", "good");

		expect(() => listedWork(act.key)).not.toThrow();
		expect(listedWork(act.key)).toEqual(["timer:good"]);
	});
});
