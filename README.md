# @marcfargas/pi-heartbeat

Non-blocking timers and heartbeats for [pi](https://github.com/badlogic/pi-mono) agents.

`pi-heartbeat` replaces blocking `sleep` waits with timers that return immediately, so the agent can pause work without freezing the session.

## What is pi?

[Pi](https://github.com/badlogic/pi-mono) is an AI coding agent CLI (`@earendil-works/pi-coding-agent`).

You run AI models in an interactive terminal, and the agent executes tools/commands while you chat with it. In that environment, `bash` calls like `sleep 60` block the active turn and prevent interaction until the command finishes.

This extension gives the agent non-blocking waiting primitives (`timer`, `heartbeat`) so it can schedule follow-ups and return to idle immediately.

## Why this extension?

Without this extension, waits are usually implemented with shell `sleep`, polling loops, or long-running turns. That causes:

- blocked chat while waiting
- poor UX for long builds/deploys
- brittle polling logic in bash

With `pi-heartbeat`:

- waits are non-blocking
- timers can be canceled
- follow-up messages include explicit context about what to check next

## Install

```bash
pi install npm:@marcfargas/pi-heartbeat
```

Or add to your `settings.json`:

```json
{
  "packages": ["npm:@marcfargas/pi-heartbeat"]
}
```

## Prerequisites

- [pi](https://github.com/badlogic/pi-mono) installed and working
- A pi session where the agent can call tools
- Extension installed via `pi install` or `settings.json`

## Tools

### `timer`

One-shot wake-up after `N` seconds.

```text
timer(seconds: 60, message: "Check if build #42 finished — run gh run view 42")
timer(seconds: 120, message: "Retry deploy check", id: "deploy-check-2")
```

- returns immediately (non-blocking)
- wakes the agent once when the timer expires
- supports multiple simultaneous timers
- optional `id` for named cancellation

### `heartbeat`

Periodic wake-up every `N` seconds until stopped.

```text
heartbeat(action: "start", interval_seconds: 30, message: "Check deploy status")
heartbeat(action: "status")
heartbeat(action: "stop")
```

- wakes the agent repeatedly with the provided message
- only one heartbeat can be active at a time
- starting a new heartbeat replaces the previous one

### `/cancel-timer`

Manual timer/heartbeat control from chat.

```text
/cancel-timer            # list active timers
/cancel-timer <id>       # cancel specific timer
/cancel-timer heartbeat  # stop heartbeat
/cancel-timer all        # cancel all timers + heartbeat
```

Use this when you need immediate control without waiting for the next trigger.

## When to Use

| Scenario | Before (blocks) | After (non-blocking) |
|----------|------------------|----------------------|
| Wait for build | `sleep 60 && gh run view 42` | `timer(60, 'Check build #42')` |
| Monitor deploy | `while true; do sleep 30; check; done` | `heartbeat(start, 30, 'Check deploy')` |
| Rate-limited API | `sleep 10` between calls | `timer(10, 'Resume API calls')` |

## How It Works

```text
User: "Start the build and let me know when it's done"

Agent: calls timer(seconds: 60, message: "Check build status")
       -> tool returns immediately
       -> agent tells user "I'll check in 60s"
       -> session stays interactive

[60 seconds later]

Timer fires -> pi triggers a new agent turn
-> agent wakes with the timer message in context
-> agent runs the follow-up check
-> if needed, schedules another timer/heartbeat
```

## vs. sleep

|  | `sleep 60` | `timer(60)` |
|---|---|---|
| Chat blocked? | ✅ Yes | ❌ No |
| User can interact? | ❌ No | ✅ Yes |
| Cancellable? | Kill process | `/cancel-timer` |
| Multiple waits? | Sequential | Concurrent |
| Wake-up context? | Shell state only | Explicit message/context |

## Limits

- `timer`
  - range: **1–3600 seconds**
  - supports multiple simultaneous timers
  - optional named `id` for cancellation
- `heartbeat`
  - interval: **10–3600 seconds**
  - only one active heartbeat at a time

## Sleep Interceptor

This package also intercepts `sleep` in bash and blocks it only when `sleep` is the **only or last command** in a call.

- `sleep 60` → **blocked** (only command)
- `npm run build && sleep 60` → **blocked** (`sleep` is last)
- `sleep 5 && npm start` → **allowed** (`sleep` is a startup delay before real work)

Disable interception with:

```bash
PI_SLEEP_INTERCEPTOR=0
```

## Best Practices

- Put actionable context in timer messages (what to check, what command to run)
- Choose reasonable intervals (don’t poll every 10s for long operations)
- Stop heartbeats when done (they continue until explicitly stopped)
- Use chained timers for progressive backoff: `30s -> 60s -> 120s`

## Development

```bash
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
```

## License

MIT
