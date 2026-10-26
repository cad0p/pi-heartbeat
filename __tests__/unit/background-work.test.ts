import { snapshotBackgroundWork } from "@cad0p/pi-background-work";
import { Value } from "@sinclair/typebox/value";
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
		const schema = act.toolSchema("timer");
		const accepts = (id: string) => Value.Check(schema, { seconds: 10, message: "x", id });

		expect(accepts("build")).toBe(true);
		expect(accepts("x".repeat(200))).toBe(true);
		expect(accepts(" build")).toBe(false);
		expect(accepts("build ")).toBe(false);
		expect(accepts("a\u0007b")).toBe(false);
		expect(accepts("x".repeat(201))).toBe(false);
		expect(accepts("a\u2028b")).toBe(true);
		expect(accepts("a\u2028b ")).toBe(false);

		// The harness calls execute directly, bypassing the schema: the provider must still skip the bad id.
		await act.setTimer(10, "x", " bad");
		await act.setTimer(60, "ok", "good");
		expect(listedWork(act.key)).toEqual(["timer:good"]);
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
