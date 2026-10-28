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
import { replaySessionState, repairTornTail } from "./session-state.js";
import { currentOwner, sameOwner } from "./process-identity.js";
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

	// Session binding: a reload keeps armed timers and the heartbeat, every other shutdown clears them.
	// A new process replays the session's log: what is still due re-arms, what came due in the meantime
	// wakes once. Both writes below go through the entry, which is empty-handed when this activation does
	// not own the session key.
	pi.on("session_start", (event, ctx) => {
		// Before the first write of this activation: a torn last line would swallow it.
		repairTornTail(ctx.sessionManager.getSessionFile());
		const mode = manager.bind(ctx.sessionManager.getSessionId(), event.reason);
		// A fork copies the parent's log into its own file, and the parent's shutdown clear went to the
		// parent file. This clear must precede the replay, or the fork's fold is not empty.
		if (event.reason === "fork") {
			manager.clearInherited();
		}
		const replayed = replaySessionState(ctx.sessionManager.getBranch(), {
			// A reload whose detach entry expired: the recorded owner is this very process, which reads as
			// alive, so only `force` can bring the work back — and only its own records, never a second
			// process's live work on the same session file.
			force: mode === "fresh" && event.reason === "reload" ? (owner) => sameOwner(owner, currentOwner()) : undefined,
		});
		if (mode === "fresh") {
			manager.restore(replayed);
		} else if (mode === "adopted") {
			manager.claim();
		}
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
