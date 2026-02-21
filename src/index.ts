/**
 * pi-heartbeat — Non-blocking timers and heartbeats for pi agents.
 *
 * Extension entry point. Registers:
 *   - timer/heartbeat tools (the alternatives to sleep)
 *   - sleep interceptor (blocks sleep >5s in bash, redirects to timer)
 *   - system prompt injection (teaches the agent about the tools)
 *   - /cancel-timer command
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerTimerTool } from "./tools/timer.js";
import { registerHeartbeatTool } from "./tools/heartbeat.js";
import { TimerManager } from "./timer-manager.js";
import { registerCancelCommand } from "./commands/cancel.js";
import { registerSleepInterceptor } from "./guards/sleep-interceptor.js";
import { registerPromptInjection } from "./guards/prompt-injection.js";

export default function activate(pi: ExtensionAPI): void {
	const manager = new TimerManager(pi);

	// Tools
	registerTimerTool(pi, manager);
	registerHeartbeatTool(pi, manager);

	// Guards — block sleep, inject prompt
	registerSleepInterceptor(pi);
	registerPromptInjection(pi);

	// Commands
	registerCancelCommand(pi, manager);

	// Cleanup
	pi.on("session_shutdown", async () => {
		manager.clearAll();
	});
}
