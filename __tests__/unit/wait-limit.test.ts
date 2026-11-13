import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Compile } from "typebox/compile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_STATE_ENTRY } from "../../src/session-state.js";
import {
	activation,
	append,
	deadOwner,
	listedWork,
	resetBackgroundWork,
	resetSessions,
	sentContents,
} from "./reload-harness.js";

/** The refusal a call rejects with, or null when it resolved. */
async function refusal(call: Promise<unknown>): Promise<string | null> {
	try {
		await call;
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

const NOW = "2026-10-28T12:00:00.000Z";

describe("wait limit: maxBackgroundWait", () => {
	let root: string;
	let cwd: string;

	beforeEach(() => {
		resetBackgroundWork();
		vi.stubEnv("PI_SLEEP_INTERCEPTOR", "1");
		root = mkdtempSync(join(tmpdir(), "pi-heartbeat-wait-limit-"));
		cwd = join(root, "project");
		mkdirSync(cwd);
	});

	afterEach(() => {
		resetSessions();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("(1) a timer longer than the default 30 minutes is refused, naming the key and the file", async () => {
		const act = activation(undefined, { cwd });
		act.start("startup");

		const message = await refusal(act.setTimer(3600, "too far"));
		expect(message).toMatch(/maxBackgroundWait.*background-work\.json.*30 minutes/);
		expect(listedWork(act.key)).toEqual([]);
	});

	it("(2) a heartbeat interval longer than the default is refused, and nothing is armed", async () => {
		const act = activation(undefined, { cwd });
		act.start("startup");

		const message = await refusal(act.startHeartbeat(3600, "too far"));
		expect(message).toMatch(/A heartbeat interval/);
		expect(message).toMatch(/maxBackgroundWait.*30 minutes/);
		expect(listedWork(act.key)).toEqual([]);
	});

	it("(3) a wait equal to the limit is accepted for both tools", async () => {
		const act = activation(undefined, { cwd });
		act.start("startup");

		expect(await refusal(act.setTimer(1800, "at the cap"))).toBeNull();
		expect(await refusal(act.startHeartbeat(1800, "at the cap"))).toBeNull();
		expect(listedWork(act.key)).toEqual(["timer:timer-1", "heartbeat:1"]);
	});

	it("(4) the policy is read per call: a project file changes the cap, a broken one falls back to 30", async () => {
		const act = activation(undefined, { cwd });
		act.start("startup");
		const policy = join(cwd, ".pi", "background-work.json");
		mkdirSync(join(cwd, ".pi"));

		expect(await refusal(act.setTimer(3600, "default cap"))).toMatch(/30 minutes/);

		writeFileSync(policy, JSON.stringify({ maxBackgroundWait: 120 }));
		expect(await refusal(act.setTimer(3600, "raised cap"))).toBeNull();

		writeFileSync(policy, JSON.stringify({ maxBackgroundWait: 1 }));
		expect(await refusal(act.setTimer(120, "a minute cap"))).toMatch(/which is 1 minute/);
		expect(await refusal(act.setTimer(60, "a minute cap"))).toBeNull();

		writeFileSync(policy, "{ not json");
		expect(await refusal(act.setTimer(3600, "broken policy"))).toMatch(/30 minutes/);
	});

	it("(5) the schema carries no static ceiling, so the policy is the only one", () => {
		const act = activation(undefined, { cwd });

		expect(Compile(act.toolSchema("timer")).Check({ seconds: 7200, message: "x" })).toBe(true);
		expect(Compile(act.toolSchema("heartbeat")).Check({ action: "start", interval_seconds: 7200 })).toBe(true);
	});

	it("(6) the sleep interceptor refuses to suggest a timer over the cap, and every suggestion is one the tool accepts", async () => {
		const act = activation(undefined, { cwd });

		const over = await act.toolCall("bash", { command: "npm run build && sleep 3600" });
		expect(over?.block).toBe(true);
		expect(over?.reason).toMatch(/maxBackgroundWait/);
		expect(over?.reason).toMatch(/30 minutes/);
		expect(over?.reason).not.toContain("timer(seconds:");

		const under = await act.toolCall("bash", { command: "sleep 60" });
		expect(under?.block).toBe(true);
		expect(under?.reason).toContain("timer(seconds: 60");

		// A fractional cap: rounding the sleep up must not print a timer the tool would refuse.
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "background-work.json"), JSON.stringify({ maxBackgroundWait: 120.5 / 60 }));
		const fractional = await act.toolCall("bash", { command: "sleep 120.4" });
		const suggested = /timer\(seconds: ([\d.]+)/.exec(fractional?.reason ?? "")?.[1];
		expect(suggested).toBeDefined();
		expect(await refusal(act.setTimer(Number(suggested), "suggested"))).toBeNull();
	});

	it("(7) restored work longer than the cap still re-arms; new requests stay capped", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date(NOW));
			const key = randomUUID();
			append(key, {
				type: "custom",
				customType: HEARTBEAT_STATE_ENTRY,
				data: {
					v: 1,
					op: "arm",
					at: NOW,
					owner: deadOwner(),
					timer: { id: "timer-1", seconds: 3600, message: "pre-cap", createdAt: NOW },
				},
			});
			append(key, {
				type: "custom",
				customType: HEARTBEAT_STATE_ENTRY,
				data: {
					v: 1,
					op: "heartbeat",
					at: NOW,
					owner: deadOwner(),
					action: "start",
					heartbeat: { id: 1, intervalSeconds: 3600, message: "pre-cap", tick: 0, createdAt: NOW },
				},
			});
			// The cap on new requests is a minute here, so only the exemption can bring this work back.
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(join(cwd, ".pi", "background-work.json"), JSON.stringify({ maxBackgroundWait: 1 }));

			const act = activation(key, { cwd });
			act.start("startup");
			expect(listedWork(key)).toEqual(["timer:timer-1", "heartbeat:1"]);
			expect(await refusal(act.setTimer(120, "new request"))).toMatch(/1 minute/);
			expect(await refusal(act.startHeartbeat(120, "new request"))).toMatch(/1 minute/);

			vi.advanceTimersByTime(3600_000);
			expect(sentContents(act)).toEqual([
				expect.stringContaining("Timer [timer-1] fired (after 3600s): pre-cap"),
				expect.stringContaining("Heartbeat #1 tick 1 (every 3600s): pre-cap"),
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("(8) a wait past Node's own timer limit is refused even when the policy allows it", async () => {
		const act = activation(undefined, { cwd });
		act.start("startup");
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "background-work.json"), JSON.stringify({ maxBackgroundWait: 40000 }));

		// Node clamps a delay of 2 ** 31 ms or more to 1 ms, so these would fire at once instead of waiting.
		const overTimer = await refusal(act.setTimer(2_147_484, "past Node"));
		const overHeartbeat = await refusal(act.startHeartbeat(2_147_484, "past Node"));
		for (const message of [overTimer, overHeartbeat]) {
			expect(message).toMatch(/2147483s/);
			expect(message).toMatch(/Node's timer limit is what binds/);
			expect(message).not.toContain("raise the setting to wait longer");
		}
		expect(listedWork(act.key)).toEqual([]);

		// The guard reads the same cap, so Node's limit binds there too and it cannot advise raising the setting.
		const blocked = await act.toolCall("bash", { command: "sleep 2147484" });
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toMatch(/2147483s/);
		expect(blocked?.reason).toMatch(/Node's timer limit is what binds/);
		expect(blocked?.reason).not.toContain("raise the setting");
		expect(blocked?.reason).not.toContain("timer(seconds:");

		expect(await refusal(act.setTimer(2_147_483, "at Node's limit"))).toBeNull();
		expect(await refusal(act.startHeartbeat(2_147_483, "at Node's limit"))).toBeNull();
		expect(listedWork(act.key)).toEqual(["timer:timer-1", "heartbeat:1"]);
	});
});
