/**
 * Process identity for persisted state: who wrote a record, and whether that writer is still alive.
 *
 * A restart cannot trust a pid alone. The os reuses pids, and a `kill -9`ed process that nobody has
 * reaped still answers `kill(pid, 0)` with the pid, boot id and start marker of its predecessor. Records
 * therefore carry the boot id and the process start marker next to the pid, and every unreadable answer
 * counts as alive: the failure direction is "do not steal another process's timers".
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Process state and start marker, as the platform reports them. Both raw: Linux field 3 and field 22. */
export interface ProcessMark {
	/** `R`, `S`, `Z`, or darwin's own first `ps` field such as `S+`/`Zs`. */
	state: string;
	/** The kernel start time (Linux, a jiffy count) or `lstart` (darwin, locale-formatted). */
	start: string;
}

/** What `kill(pid, 0)` answered: `missing` is ESRCH, `denied` is EPERM, `present` is success. */
export type PidAnswer = "missing" | "denied" | "present" | "unknown";

/** Everything the liveness rules need from the host; injectable so tests never spawn a process. */
export interface OwnerProbe {
	/** The boot id this host reports, or {@link UNKNOWN_BOOT} when it cannot be read. Read once. */
	boot(): string;
	/** The process state and start marker, or `undefined` when unreadable. Memoized per pid. */
	inspect(pid: number): ProcessMark | undefined;
	answer(pid: number): PidAnswer;
}

/** Who wrote a record: the pid, the boot it ran under, its start marker, and its own uptime when written. */
export interface PersistOwner {
	pid: number;
	boot: string;
	start?: string;
	uptime: number;
}

/** A marker no probe could read. Never equals another marker, never proves death. */
export const UNKNOWN_BOOT = "unknown";

/** `ps`/`sysctl` are local and fast; a hung one must not hold `session_start`. */
const SPAWN_TIMEOUT_MS = 2000;

/** `kill(pid, 0)`: the only pid check every platform shares. */
function pidAnswer(pid: number): PidAnswer {
	if (!Number.isInteger(pid) || pid <= 0) {
		return "unknown";
	}
	try {
		process.kill(pid, 0);
		return "present";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") {
			return "missing";
		}
		if (code === "EPERM") {
			return "denied";
		}
		return "unknown";
	}
}

function known(marker: string | undefined): marker is string {
	return marker !== undefined && marker !== "" && marker !== UNKNOWN_BOOT;
}

/** Two markers differ only when both are known: an unreadable one never proves death. */
function differs(recorded: string | undefined, seen: string | undefined): boolean {
	return known(recorded) && known(seen) && recorded !== seen;
}

function once(read: () => string): () => string {
	let value: string | undefined;
	return () => {
		value ??= read();
		return value;
	};
}

/** One read per pid: `session_start` inspects each distinct owner once, not once per record. */
function memoizeMark(read: (pid: number) => ProcessMark | undefined): (pid: number) => ProcessMark | undefined {
	const memo = new Map<number, { mark?: ProcessMark }>();
	return (pid) => {
		let hit = memo.get(pid);
		if (hit === undefined) {
			hit = { mark: read(pid) };
			memo.set(pid, hit);
		}
		return hit.mark;
	};
}

function readLinuxBoot(): string {
	try {
		const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		return boot === "" ? UNKNOWN_BOOT : boot;
	} catch {
		return UNKNOWN_BOOT;
	}
}

/**
 * Linux: `state` (field 3) and `starttime` (field 22) from /proc/<pid>/stat. The command name in field 2
 * is parenthesized and may itself contain spaces or `)`, so the fields start after the last `)`.
 */
function readLinuxMark(pid: number): ProcessMark | undefined {
	let stat: string;
	try {
		stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		// No /proc entry: the process is gone, or this platform has no /proc.
		return undefined;
	}
	const open = stat.lastIndexOf(")");
	if (open < 0) {
		return undefined;
	}
	const fields = stat.slice(open + 2).trim().split(/\s+/);
	const state = fields[0];
	const start = fields[19];
	return state === undefined || start === undefined ? undefined : { state, start };
}

/** Runs one short-lived command; injectable so the darwin parse is testable off a mac. */
export type Spawn = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => string;

function spawnBounded(command: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
	return execFileSync(command, [...args], {
		encoding: "utf8",
		env,
		timeout: SPAWN_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "ignore"],
	});
}

/**
 * `lstart` is locale- and timezone-formatted. Both the write and the read pin `LC_ALL=C` and `TZ=UTC`,
 * so a value written under another locale reads as a mismatch instead of a false "dead" — and even a
 * mismatch only ever means "cannot prove death" when a marker is unreadable.
 */
function pinnedEnv(): NodeJS.ProcessEnv {
	return { ...process.env, LC_ALL: "C", TZ: "UTC" };
}

function readDarwinBoot(spawn: Spawn): string {
	try {
		const out = spawn("sysctl", ["-n", "kern.boottime"], pinnedEnv()).trim();
		return out === "" ? UNKNOWN_BOOT : out;
	} catch {
		return UNKNOWN_BOOT;
	}
}

/** darwin: one `ps` per pid returns both parts, `stat=` then the five `lstart=` fields. */
function readDarwinMark(spawn: Spawn, pid: number): ProcessMark | undefined {
	let out: string;
	try {
		out = spawn("ps", ["-p", String(pid), "-o", "stat=,lstart="], pinnedEnv());
	} catch {
		return undefined;
	}
	const fields = out.trim().split(/\s+/);
	const [state, ...rest] = fields;
	if (state === undefined || rest.length < 5) {
		return undefined;
	}
	return { state, start: rest.join(" ") };
}

/** A Linux probe (or any host without /proc: `boot` unknown, no mark, pid alone decides). */
export function linuxProbe(read: (pid: number) => ProcessMark | undefined = readLinuxMark, bootId: () => string = readLinuxBoot): OwnerProbe {
	return { boot: once(bootId), inspect: memoizeMark(read), answer: pidAnswer };
}

/** A darwin probe; {`spawn`} is injectable so the parse and the pinned env are testable on any host. */
export function darwinProbe(spawn: Spawn = spawnBounded): OwnerProbe {
	return {
		boot: once(() => readDarwinBoot(spawn)),
		inspect: memoizeMark((pid) => readDarwinMark(spawn, pid)),
		answer: pidAnswer,
	};
}

let sharedProbe: OwnerProbe | undefined;

/** The host's probe, one per process: the boot id and each pid's mark are read once. */
export function systemProbe(): OwnerProbe {
	sharedProbe ??= process.platform === "darwin" ? darwinProbe() : linuxProbe();
	return sharedProbe;
}

let selfOwner: PersistOwner | undefined;

/** This process's identity. Memoized: it is written into every record and cannot change. */
export function currentOwner(): PersistOwner {
	if (selfOwner === undefined) {
		const probe = systemProbe();
		const mark = probe.inspect(process.pid);
		selfOwner = {
			pid: process.pid,
			boot: probe.boot(),
			start: mark?.start,
			uptime: process.uptime(),
		};
	}
	return selfOwner;
}

/**
 * Is the recorded owner still the process that wrote the record? Ordered cheapest and most decisive
 * first, and every answer that cannot be read counts as alive.
 *
 * - `ESRCH` is dead; `EPERM` is another user's live process; any other failure is unreadable.
 * - state `Z` is dead: a `kill -9`ed process that nobody has reaped still answers `kill(pid, 0)`, and
 *   matches pid, boot and start, so it is the primary crash shape.
 * - a different boot id (reboot) or a different start marker (pid reuse) is dead.
 * - the same pid as this process is dead only when its recorded uptime is ahead of ours, i.e. the pid
 *   was ours before a restart in which every marker was unreadable.
 */
export function ownerAlive(owner: PersistOwner, probe: OwnerProbe = systemProbe(), self: PersistOwner = currentOwner()): boolean {
	try {
		const answer = probe.answer(owner.pid);
		if (answer === "missing") {
			return false;
		}
		if (answer !== "present") {
			return true;
		}
		const seen = probe.inspect(owner.pid);
		if (seen === undefined) {
			return true;
		}
		if (seen.state.trim().startsWith("Z")) {
			return false;
		}
		if (differs(owner.boot, probe.boot())) {
			return false;
		}
		if (differs(owner.start, seen.start)) {
			return false;
		}
		if (owner.pid === self.pid && owner.uptime > self.uptime + 1) {
			return false;
		}
		return true;
	} catch {
		// A probe that throws is a probe that cannot prove death.
		return true;
	}
}

