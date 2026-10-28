/**
 * pi-heartbeat — Non-blocking timers and heartbeats for pi agents.
 *
 * Extension entry point. Registers:
 *   - timer/heartbeat tools (the alternatives to sleep)
 *   - sleep interceptor (blocks sleep >5s in bash, redirects to timer)
 *   - system prompt injection (teaches the agent about the tools)
 *   - /cancel-timer command
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTimerTool } from "./tools/timer.js";
import { registerHeartbeatTool } from "./tools/heartbeat.js";
import { registerProvider } from "./background-work.js";
import { registerDisplayProvider } from "./display-provider.js";
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

	// Session binding: a reload keeps armed timers and the heartbeat, every other shutdown clears them
	pi.on("session_start", (event, ctx) => {
		manager.bind(ctx.sessionManager.getSessionId(), event.reason);
		registerProvider(event.reason);
		registerDisplayProvider(event.reason);
	});
	pi.on("session_shutdown", (event) => {
		if (event.reason === "reload") {
			manager.detach();
		} else {
			manager.end();
		}
	});
}
