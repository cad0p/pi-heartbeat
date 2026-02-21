/**
 * /cancel-timer command — list or cancel timers and heartbeats.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TimerManager } from "../timer-manager.js";

export function registerCancelCommand(pi: ExtensionAPI, manager: TimerManager): void {
	pi.registerCommand("cancel-timer", {
		description: "Cancel a timer by ID, 'heartbeat' to stop the heartbeat, or 'all' for everything",
		handler: async (args, ctx) => {
			const target = args.trim();

			if (!target) {
				const timers = manager.getActiveTimerIds();
				const hb = manager.getHeartbeatState();
				const hbText = hb
					? `Heartbeat #${hb.id} active (every ${hb.intervalSeconds}s, ${hb.tick} ticks)`
					: "No heartbeat";
				ctx.ui.notify(
					`Timers: ${timers.length ? timers.join(", ") : "none"}. ${hbText}`,
					"info",
				);
				return;
			}

			if (target === "all") {
				manager.clearAll();
				ctx.ui.notify("All timers and heartbeats cancelled.", "info");
				return;
			}

			if (target === "heartbeat") {
				const stopped = manager.stopHeartbeat();
				if (stopped) {
					ctx.ui.notify(`Heartbeat #${stopped.id} stopped.`, "info");
				} else {
					ctx.ui.notify("No heartbeat was running.", "warning");
				}
				return;
			}

			if (manager.cancelTimer(target)) {
				ctx.ui.notify(`Timer [${target}] cancelled.`, "info");
			} else {
				ctx.ui.notify(`No timer with ID [${target}] found.`, "warning");
			}
		},
	});
}
