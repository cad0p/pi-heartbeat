/**
 * The longest wait a new timer or heartbeat may ask for.
 *
 * `maxBackgroundWait` from @cad0p/pi-background-work is the line between background work, which a
 * session waits on, and scheduled work, which comes from outside. Timers and heartbeats are
 * background work, so neither may outlast it. The policy is read on every call, so an edit applies
 * without a restart; the package never throws and falls back to its own default when the file is
 * missing, unreadable or invalid, so a broken policy is that default, never "no limit".
 */

import { readBackgroundWorkPolicy } from "@cad0p/pi-background-work";

/** Named in the refusal so the user can find the setting; the package reads it in both places. */
const SETTING = "`maxBackgroundWait` in `background-work.json` (the project's `.pi/` or the agent directory)";

/** The cap in seconds — the policy states it in minutes. */
export function maxWaitSeconds(cwd: string): number {
	return readBackgroundWorkPolicy({ cwd }).policy.maxBackgroundWait * 60;
}

/**
 * The cap in the unit it is configured in, so a refusal reads the way the setting does. Rounded to
 * hundredths: a fractional value in the file (0.5) would otherwise print float noise after the round
 * trip through seconds.
 */
export function describeWait(limitSeconds: number): string {
	const minutes = Math.round((limitSeconds / 60) * 100) / 100;
	return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** Why a wait is refused, or undefined when it is accepted. A wait equal to the cap is accepted. */
export function waitRefusal(kind: "timer" | "heartbeat", seconds: number, cwd: string): string | undefined {
	const limit = maxWaitSeconds(cwd);
	if (seconds <= limit) return undefined;
	const subject = kind === "timer" ? "A timer" : "A heartbeat interval";
	const cap = describeWait(limit);
	return (
		`Refused: ${seconds}s is longer than ${SETTING}, which is ${cap} here. ` +
		`${subject} is background work, so it may not outlast that limit. ` +
		`Waits of ${cap} or less are accepted; raise the setting to wait longer.`
	);
}
