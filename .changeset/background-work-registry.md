---
"@marcfargas/pi-heartbeat": minor
---

Timers and heartbeats now advertise pending background work through the shared `pi:background-work` registry.

Completion-notifier extensions that hook pi's `agent_settled` event fire as soon as the agent loop has no automatic continuations left — but a pending timer or an active heartbeat will wake the agent later, so the notification can still be premature. This package now acquires a token in the shared registry (a `globalThis` registry behind `Symbol.for("pi:background-work")`) whenever a timer is scheduled or a heartbeat is running, and releases it when the work fires, is cancelled, or is stopped.

Notifier extensions that understand the protocol (e.g. a background-aware variant of pi's `notify` example) can defer their notification until `pending()` reaches zero. The protocol is opt-in and self-initializing: if no other extension participates, behavior is unchanged. See `src/background-work.ts` for the protocol documentation.
