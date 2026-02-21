/**
 * Timer tool — one-shot non-blocking "wake me up in N seconds".
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TimerManager } from "../timer-manager.js";

export function registerTimerTool(pi: ExtensionAPI, manager: TimerManager): void {
	pi.registerTool({
		name: "timer",
		label: "Timer",
		description:
			"Set a non-blocking timer. Returns immediately — you go idle and the user can chat. " +
			"When the timer fires, you get woken up with the message. " +
			"Use this instead of `sleep` when you need to wait for something " +
			"(build completion, deployment, polling intervals, etc.). " +
			"You can set multiple timers simultaneously.",
		parameters: Type.Object({
			seconds: Type.Number({
				description: "Delay in seconds before waking up",
				minimum: 1,
				maximum: 3600,
			}),
			message: Type.String({
				description:
					"Context message delivered when timer fires. Include what you were waiting for " +
					"and what to do next, e.g. 'Check if build #42 finished — run `gh run view 42`'",
			}),
			id: Type.Optional(
				Type.String({
					description: "Optional timer ID for cancellation. Auto-generated if omitted.",
				}),
			),
		}),

		async execute(_toolCallId, params) {
			const timerId = manager.setTimer(params.seconds, params.message, params.id);

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Timer [${timerId}] set for ${params.seconds}s. ` +
							`You will be woken up with: "${params.message}". ` +
							`Finish your response — the user can chat freely while waiting.`,
					},
				],
				details: { timerId, seconds: params.seconds },
			};
		},
	});
}
