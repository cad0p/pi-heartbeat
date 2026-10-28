# @cad0p/pi-heartbeat

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
pi install npm:@cad0p/pi-heartbeat
```

Or add to your `settings.json`:

```json
{
  "packages": ["npm:@cad0p/pi-heartbeat"]
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

### Surviving `/reload`

Armed timers and the heartbeat survive `/reload`: a timer keeps its original deadline, a fire that lands during the reload is delivered once by the reloaded session that adopts it (a detach the reload never adopts is retired after 5 minutes, as before), a heartbeat keeps at most one queued tick, and ids continue (`timer-N+1`, next heartbeat number). Any other shutdown (quit, new, resume, fork) clears them as before.

The code being reloaded from decides this. The first `/reload` after updating from an older version still clears timers and the heartbeat; every later reload keeps them.

If the extension is loaded twice into the same session, the second copy keeps its timers separate from the first, and those timers do not survive `/reload`.

### Background work

While timers are armed, the heartbeat runs, or a heartbeat tick or one-shot timer fires during a `/reload` gap and waits to be delivered, the session has background work. The extension registers itself as the `pi-heartbeat` provider of `@cad0p/pi-background-work`, so consumers such as `bg_wait` see it. Items are `timer:<id>`, `heartbeat:<n>`, `pending:<seq>` for a queued tick or timer, and `pending:legacy-<i>` for one queued before sequence numbers existed. The extension also registers a display provider, so the package's `bg-work` footer describes the work instead of counting it: one timer reads `timer-1 0:42`, several read `2 timers: timer-1 0:42, timer-2 1:05`, and a running heartbeat leads with the time to its next tick (`heartbeat 4:30 · 2 timers: …`). A queued wake folds into the timer or heartbeat that owes it; a wake that cannot be attributed reads `wake queued`. Timer ids must be 1-200 characters (the tool's schema counts code points), with no edge whitespace and no control characters, and at most 250 UTF-16 units so `timer:<id>` fits the package's 256-unit id budget; the two limits differ only for astral characters, which count as two units, so 200 astral characters pass the schema and are refused by the manager; the `timer` tool rejects other ids, and the provider skips any armed id the package would still reject, so one bad id does not fail a listing.

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
