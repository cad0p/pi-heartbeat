/**
 * Heartbeat tool — periodic non-blocking "ping me every N seconds".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TimerManager } from "../timer-manager.js";

export function registerHeartbeatTool(pi: ExtensionAPI, manager: TimerManager): void {
	pi.registerTool({
		name: "heartbeat",
		label: "Heartbeat",
		description:
			"Start or stop a periodic heartbeat. When running, you get woken up every N seconds " +
			"with a status check message. Use for long-running monitoring " +
			"(deployment progress, CI pipeline, server health, process supervision). " +
			"Only one heartbeat can be active at a time. Starting a new one stops the previous.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("status")]),
			interval_seconds: Type.Optional(
				Type.Number({
					description: "Interval between heartbeats in seconds (default: 60, min: 10)",
					minimum: 10,
					maximum: 3600,
				}),
			),
			message: Type.Optional(
				Type.String({
					description:
						"Context for each heartbeat ping, e.g. 'Check deployment status on staging'",
				}),
			),
		}),

		async execute(_toolCallId, params): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, any> }> {
			if (params.action === "status") {
				const state = manager.getHeartbeatState();
				if (state) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Heartbeat #${state.id} active — every ${state.intervalSeconds}s, ${state.tick} ticks so far. Message: "${state.message}"`,
							},
						],
						details: { active: true, ...state },
					};
				}
				const timers = manager.getActiveTimerIds();
				return {
					content: [
						{
							type: "text" as const,
							text: `No heartbeat active. Active timers: ${timers.length ? timers.join(", ") : "none"}.`,
						},
					],
					details: { active: false, timers },
				};
			}

			if (params.action === "stop") {
				const stopped = manager.stopHeartbeat();
				if (stopped) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Heartbeat #${stopped.id} stopped after ${stopped.tick} ticks.`,
							},
						],
						details: { stopped: true, ...stopped },
					};
				}
				return {
					content: [{ type: "text" as const, text: "No heartbeat was running." }],
					details: { stopped: false },
				};
			}

		// action === "start"
			const intervalSec = params.interval_seconds ?? 60;
			const msg = params.message ?? "Periodic status check";
			const state = manager.startHeartbeat(intervalSec, msg);

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Heartbeat #${state.id} started — pinging every ${intervalSec}s. ` +
							`Message: "${msg}". ` +
							`Use heartbeat(action: "stop") to cancel. ` +
							`Finish your response — the user can chat freely.`,
					},
				],
				details: { heartbeatId: state.id, intervalSeconds: intervalSec },
			};
		},
	});
}
