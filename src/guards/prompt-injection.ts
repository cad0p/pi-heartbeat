/**
 * System prompt injection — tells the agent about timer/heartbeat on every turn.
 *
 * Injected via before_agent_start so the agent knows the tools exist
 * even if the skill isn't loaded.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TIMER_PROMPT = `
## Non-blocking Timers (pi-heartbeat extension)

You have two tools for non-blocking waiting. **Never use \`sleep\` for delays >5 seconds** — it blocks the chat.

- **\`timer(seconds, message)\`** — One-shot. Returns immediately, wakes you up after N seconds with the message. Use instead of \`sleep\`.
- **\`heartbeat(action, interval_seconds, message)\`** — Periodic. Pings you every N seconds. Use for monitoring (deploys, CI, long builds).

When you need to wait for something:
1. Call \`timer(seconds: N, message: "what to check and how")\`
2. Tell the user you'll check back in Ns
3. Finish your response — user can chat freely
4. When woken up, check status and act (or set another timer)
`.trim();

export function registerPromptInjection(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: event.systemPrompt + "\n\n" + TIMER_PROMPT,
		};
	});
}
