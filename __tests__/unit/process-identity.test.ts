import { describe, expect, it } from "vitest";
import {
	type OwnerProbe,
	type PersistOwner,
	type Spawn,
	UNKNOWN_BOOT,
	currentOwner,
	darwinProbe,
	ownerAlive,
	systemProbe,
} from "../../src/process-identity.js";

const OWNER: PersistOwner = { pid: 4242, boot: "boot-a", start: "100", uptime: 10 };
const SELF: PersistOwner = { pid: 1, boot: "boot-a", start: "100", uptime: 100 };

function probeOf(partial: Partial<OwnerProbe>): OwnerProbe {
	return {
		boot: () => "boot-a",
		inspect: () => ({ state: "S", start: "100" }),
		answer: () => "present",
		...partial,
	};
}

describe("process identity: is the recorded owner still alive", () => {
	it("(1) this process's own record is alive", () => {
		expect(ownerAlive(currentOwner())).toBe(true);
	});

	it("(2) ESRCH is dead, EPERM is alive", () => {
		expect(ownerAlive(OWNER, probeOf({ answer: () => "missing" }), SELF)).toBe(false);
		// EPERM means another user's process: alive, and its marks are not ours to judge.
		const denied = probeOf({ answer: () => "denied", boot: () => "boot-b", inspect: () => ({ state: "Z", start: "999" }) });
		expect(ownerAlive(OWNER, denied, SELF)).toBe(true);
	});

	it("(3) a different boot id is dead, an unknown boot id never is", () => {
		expect(ownerAlive(OWNER, probeOf({ boot: () => "boot-b" }), SELF)).toBe(false);
		expect(ownerAlive(OWNER, probeOf({ boot: () => UNKNOWN_BOOT }), SELF)).toBe(true);
		expect(ownerAlive({ ...OWNER, boot: UNKNOWN_BOOT }, probeOf({ boot: () => "boot-b" }), SELF)).toBe(true);
	});

	it("(4) a different start marker is dead, i.e. the pid now belongs to another process", () => {
		expect(ownerAlive(OWNER, probeOf({ inspect: () => ({ state: "S", start: "999" }) }), SELF)).toBe(false);
		expect(ownerAlive({ ...OWNER, start: undefined }, probeOf({ inspect: () => ({ state: "S", start: "999" }) }), SELF)).toBe(true);
	});

	it("(5) a zombie is dead even with pid, boot and start all matching", () => {
		expect(ownerAlive(OWNER, probeOf({ inspect: () => ({ state: "Z", start: "100" }) }), SELF)).toBe(false);
		// darwin reports a zombie as `Z` with flags attached.
		expect(ownerAlive(OWNER, probeOf({ inspect: () => ({ state: "Zs", start: "100" }) }), SELF)).toBe(false);
	});

	it("(6) the same pid with a larger recorded uptime is dead: the pid was ours before a restart", () => {
		const self: PersistOwner = { pid: 555, boot: "boot-a", start: "100", uptime: 10 };
		const older: PersistOwner = { pid: 555, boot: "boot-a", start: "100", uptime: 20 };
		const probe = probeOf({ inspect: () => ({ state: "S", start: "100" }) });

		expect(ownerAlive(older, probe, self)).toBe(false);
		expect(ownerAlive({ ...older, uptime: 11 }, probe, self)).toBe(true);
		expect(ownerAlive({ ...older, uptime: 10 }, probe, self)).toBe(true);
	});

	it("(7) an unreadable probe is alive: nothing may prove death", () => {
		expect(ownerAlive(OWNER, probeOf({ inspect: () => undefined }), SELF)).toBe(true);
		expect(ownerAlive({ ...OWNER, start: undefined, boot: UNKNOWN_BOOT }, probeOf({ inspect: () => undefined }), SELF)).toBe(true);
		expect(ownerAlive(OWNER, probeOf({ answer: () => "unknown" }), SELF)).toBe(true);
	});

	it("(8) the system probe and this process's identity are stable and never throw", () => {
		const probe = systemProbe();
		expect(systemProbe()).toBe(probe);
		const self = currentOwner();
		expect(currentOwner()).toBe(self);
		expect(self.pid).toBe(process.pid);
		expect(probe.boot().length).toBeGreaterThan(0);
		expect(() => ownerAlive(self, probe, self)).not.toThrow();
		expect(ownerAlive(self, probe, self)).toBe(true);
	});

	it("(9) a platform with no boot id and no start marker decides by pid alone", () => {
		const pidOnly = probeOf({ boot: () => UNKNOWN_BOOT, inspect: () => undefined, answer: systemProbe().answer });
		const dead: PersistOwner = { pid: 999999, boot: UNKNOWN_BOOT, start: undefined, uptime: 0 };

		expect(ownerAlive(dead, pidOnly, SELF)).toBe(false);
		expect(ownerAlive({ ...dead, pid: process.pid }, pidOnly, { ...SELF, uptime: 1000 })).toBe(true);
	});

	it("(10) the darwin probe pins the locale, reads one ps per pid and parses both fields", () => {
		const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
		const spawn: Spawn = (command, args, env) => {
			calls.push({ command, args, env });
			return command === "sysctl" ? "{ sec = 1726651234, usec = 0 } Wed Sep 18 08:00:34 2025\n" : "S+ Sat Oct 11 12:00:00 2025\n";
		};
		const probe = darwinProbe(spawn);

		const boot = probe.boot();
		expect(boot).toBe("{ sec = 1726651234, usec = 0 } Wed Sep 18 08:00:34 2025");
		expect(probe.boot()).toBe(boot);
		expect(probe.inspect(123)).toEqual({ state: "S+", start: "Sat Oct 11 12:00:00 2025" });
		expect(probe.inspect(123)).toEqual({ state: "S+", start: "Sat Oct 11 12:00:00 2025" });
		expect(probe.inspect(456)).toEqual({ state: "S+", start: "Sat Oct 11 12:00:00 2025" });

		const ps = calls.filter((call) => call.command === "ps");
		expect(ps).toHaveLength(2);
		expect(ps[0].args).toEqual(["-p", "123", "-o", "stat=,lstart="]);
		expect(calls.filter((call) => call.command === "sysctl")).toHaveLength(1);
		for (const call of calls) {
			expect(call.env.LC_ALL).toBe("C");
			expect(call.env.TZ).toBe("UTC");
		}

		// A failing spawn reads as unreadable, which is alive, and never as an empty marker.
		const failing = darwinProbe(() => {
			throw new Error("ps: command not found");
		});
		expect(failing.boot()).toBe(UNKNOWN_BOOT);
		expect(failing.inspect(123)).toBeUndefined();
	});
});
