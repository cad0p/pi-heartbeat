/**
 * Sleep interceptor — catches `sleep` in bash commands and redirects to timer tool.
 *
 * Short sleeps (≤5s) are allowed — they're typically "wait for server to boot".
 * Longer sleeps get blocked with a message telling the agent to use `timer` instead.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

/** Threshold in seconds — sleeps above this get blocked */
const SLEEP_THRESHOLD = 5;

/**
 * Match sleep commands and extract the duration.
 * Handles: sleep 60, sleep 60s, sleep 1m, sleep 0.5h,
 *          sleep 60 &&, sleep 60;, sleep 60 |
 */
const SLEEP_PATTERN = /\bsleep\s+(\d+(?:\.\d+)?)\s*([smh]?)(?:\s|;|&|\||$)/g;

export function parseSleepSeconds(command: string): number | null {
	SLEEP_PATTERN.lastIndex = 0;
	let maxSleep = 0;
	let found = false;

	let match: RegExpExecArray | null;
	while ((match = SLEEP_PATTERN.exec(command)) !== null) {
		found = true;
		const value = parseFloat(match[1]);
		const unit = match[2] || "s";

		let seconds = value;
		if (unit === "m") seconds = value * 60;
		if (unit === "h") seconds = value * 3600;

		maxSleep = Math.max(maxSleep, seconds);
	}

	return found ? maxSleep : null;
}

export function registerSleepInterceptor(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command;
		const sleepSeconds = parseSleepSeconds(command);

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
