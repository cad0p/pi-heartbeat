/**
 * Sleep interceptor — catches `sleep` in bash commands and redirects to timer tool.
 *
 * Short sleeps (≤5s) are allowed — they're typically "wait for server to boot".
 * Longer sleeps get blocked with a message telling the agent to use `timer` instead — or, when the
 * sleep is longer than `maxBackgroundWait`, that no timer that long would be accepted either.
 *
 * Only blocks when sleep is the LAST (or only) command segment — a leading
 * `sleep 60 && curl something` is fine; a trailing `build && sleep 60` is not.
 *
 * Disable entirely by setting env var: PI_SLEEP_INTERCEPTOR=0
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { describeWait, maxWaitSeconds } from "../wait-limit.js";

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

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command;
		const sleepSeconds = getTrailingSleepSeconds(command);

		if (sleepSeconds === null || sleepSeconds <= SLEEP_THRESHOLD) return;

		const header = `Blocked: \`sleep ${sleepSeconds}s\` blocks the chat — the user can't interact while waiting.`;
		const footer = `Short sleeps (≤${SLEEP_THRESHOLD}s) are still allowed for things like waiting for a server to boot.`;
		const limit = maxWaitSeconds(ctx.cwd);
		const cap = describeWait(limit);

		if (sleepSeconds > limit) {
			return {
				block: true,
				reason:
					`${header}\n\n` +
					`That wait is longer than ${cap}, the cap on background waits (\`maxBackgroundWait\` in \`background-work.json\`, the project's \`.pi/\` or the agent directory), so the \`timer\` and \`heartbeat\` tools would refuse it too. ` +
					`Split it into waits of ${cap} or less, or raise the setting if the long wait is intended.\n\n` +
					footer,
			};
		}

		// A timer at the sleep's length, never longer than the cap, so the suggestion is one the tool accepts.
		const suggestion = Math.min(Math.ceil(sleepSeconds), limit);
		return {
			block: true,
			reason:
				`${header}\n\n` +
				`Use the \`timer\` tool instead:\n` +
				`  timer(seconds: ${suggestion}, message: "describe what you're waiting for and what to check")\n\n` +
				`The timer returns immediately (non-blocking), then wakes you up after ${suggestion}s.\n` +
				`For periodic checks, use \`heartbeat(action: "start", interval_seconds: ${Math.min(suggestion, 60)})\`.\n\n` +
				footer,
		};
	});
}
