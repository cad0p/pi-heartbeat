/**
 * Sleep interceptor — catches `sleep` in bash commands and redirects to timer tool.
 *
 * Short sleeps (≤5s) are allowed — they're typically "wait for server to boot".
 * Longer sleeps get blocked with a message telling the agent to use `timer` instead.
 *
 * Only blocks when sleep is the LAST (or only) command segment — a leading
 * `sleep 60 && curl something` is fine; a trailing `build && sleep 60` is not.
 *
 * Disable entirely by setting env var: PI_SLEEP_INTERCEPTOR=0
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

/** Threshold in seconds — sleeps above this get blocked */
const SLEEP_THRESHOLD = 5;

/** Matches a segment that is SOLELY a sleep call (no operators). */
const SOLE_SLEEP_PATTERN = /^\s*sleep\s+(\d+(?:\.\d+)?)\s*([smh]?)\s*$/;

/**
 * Parse sleep duration from a SINGLE command segment (no operators).
 * Segment must be SOLELY a sleep command (whitespace OK).
 * Pattern: /^\s*sleep\s+(\d+(?:\.\d+)?)\s*([smh]?)\s*$/
 * Returns null if not a sole sleep.
 */
export function segmentSleepSeconds(segment: string): number | null {
	const match = SOLE_SLEEP_PATTERN.exec(segment);
	if (!match) return null;

	const value = parseFloat(match[1]);
	const unit = match[2] || "s";

	if (unit === "m") return value * 60;
	if (unit === "h") return value * 3600;
	return value;
}

/**
 * Returns sleep duration if the command's LAST segment is a sleep call.
 * Splits on &&, ||, |, ; (simple split, best-effort, no quote handling).
 * Trims and filters empty segments. Checks the last one.
 * Returns null if sleep is not the trailing command (or no sleep).
 */
export function getTrailingSleepSeconds(command: string): number | null {
	const segments = command
		.split(/&&|\|\||[|;]/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	if (segments.length === 0) return null;

	const last = segments[segments.length - 1];
	return segmentSleepSeconds(last);
}

export function registerSleepInterceptor(pi: ExtensionAPI): void {
	if (process.env.PI_SLEEP_INTERCEPTOR === "0") return;

	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command;
		const sleepSeconds = getTrailingSleepSeconds(command);

		if (sleepSeconds === null || sleepSeconds <= SLEEP_THRESHOLD) return;

		return {
			block: true,
			reason:
				`Blocked: \`sleep ${sleepSeconds}s\` blocks the chat — the user can't interact while waiting.\n\n` +
				`Use the \`timer\` tool instead:\n` +
				`  timer(seconds: ${Math.ceil(sleepSeconds)}, message: "describe what you're waiting for and what to check")\n\n` +
				`The timer returns immediately (non-blocking), then wakes you up after ${Math.ceil(sleepSeconds)}s.\n` +
				`For periodic checks, use \`heartbeat(action: "start", interval_seconds: ${Math.min(Math.ceil(sleepSeconds), 60)})\`.\n\n` +
				`Short sleeps (≤${SLEEP_THRESHOLD}s) are still allowed for things like waiting for a server to boot.`,
		};
	});
}
