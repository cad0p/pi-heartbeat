---
"@marcfargas/pi-heartbeat": minor
---

Initial release.

- `timer` tool: non-blocking one-shot wake-up. Returns immediately; fires a context message after N seconds to wake the agent. Multiple timers can be active simultaneously. Optional named `id` for cancellation.
- `heartbeat` tool: periodic wake-up every N seconds. Start/stop/status actions. Use for monitoring long-running operations (deploys, CI pipelines, server health).
- Sleep interceptor: automatically blocks `sleep` in bash when it is the last or only command, redirecting the agent to use `timer` instead. Configurable via `PI_SLEEP_INTERCEPTOR=0`.
- `/cancel-timer` command: cancel timers or the heartbeat by ID directly from chat.
