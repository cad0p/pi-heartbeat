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

Armed timers and the heartbeat survive `/reload`: a timer keeps its original deadline, a fire that lands during the reload is delivered once by the reloaded session that adopts it (a detach no reload adopts is retired after 5 minutes, and the next start or reload re-arms the work from the session's log instead), a heartbeat keeps at most one queued tick, and ids continue (`timer-N+1`, next heartbeat number). Any other shutdown (quit, new, resume, fork) clears them as before.

The code being reloaded from decides this. The first `/reload` after updating from an older version still clears timers and the heartbeat; every later reload keeps them.

If the extension is loaded twice into the same session, the second copy keeps its timers separate from the first, and those timers do not survive `/reload`.

### Surviving a restart

Armed work is also written to the session, one custom entry per action, so a new pi process can pick it up. Custom entries never reach the model. When a process opens the session — after a crash, a `kill -9` or a reboot, or a `resume` — it replays them:

- a timer **still due** re-arms for its remaining time, counted from when it was armed: a restart never extends a wait
- a timer that **came due while pi was not running** wakes the agent once, with every overdue timer in one message:

  ```text
  ⏰ timer-27 fired 35 min late (due 14:05; pi was not running): check CI
  ⏰ 2 timers fired while pi was not running:
  - timer-27: 35 min late, due 14:05: check CI
  - timer-31: 1 h 20 min late, due 2026-10-26 14:20: check deploy
  ```

  A due date that is not today is written out in full, a gap of days reads as days, oldest first, and there is no age bound: press Esc to stop the turn. The `fire` is written before the wake, so a crash during that turn does not fire it again.
- a **heartbeat** resumes: one catch-up ping if a tick was missed, then its normal interval from the last tick it recorded. The number continues (`#2` after `#1`); the tick count itself picks up where it left off after a `/reload`, and after a crash from the last tick the session recorded, since a tick is not written on every pass
- ids continue (`timer-N+1`, next heartbeat number), so a new timer cannot replace a re-armed one

A deliberate shutdown (`quit`, `new`, `resume`) writes one `clear` naming the timers and the heartbeat that process was holding, and only those — so quitting and reopening fires nothing, while a second pi process on the same session file cannot cancel work the first one is still counting down. A `/fork` empties its own copy of the parent's log before replaying it, and the parent file keeps its timers.

Durability is at-least-once where a repeat is the safe failure and at-most-once where it is not. A `clear` cut off by a crash can re-arm one cancelled timer, a `fire` cut off the same way can repeat one wake, a torn `arm` is a timer that never existed, and a torn last line is repaired before the first record of the new process is written. In the other direction the `fire` is durable *before* its wake is delivered, so a crash inside that window loses the one wake instead of repeating it.

Work whose recorded owner is still alive (another pi process, or the same pid before a restart) is never taken from it. The one exception is a `/reload` whose detach grace expired: the record names this very process and nothing else is counting the timer down, so the reload reclaims it — and only records that pass that test.

Two cases where nothing re-arms, both deliberate: a second copy of the extension on the same session neither replays nor writes (the copy that owns the session key does), and a registry entry written by a newer version is replaced rather than read, so that activation keeps its timers in memory only. Two pi processes opening the same session file at the same instant are not reconciled: both replay and both arm, and the later `arm` for an id wins on disk.

### Background work

While timers are armed, the heartbeat runs, or a heartbeat tick or one-shot timer fires during a `/reload` gap and waits to be delivered, the session has background work. The extension registers itself as the `pi-heartbeat` provider of `@cad0p/pi-background-work`, so consumers such as `bg_wait` see it. Items are `timer:<id>`, `heartbeat:<n>`, `pending:<seq>` for a queued tick or timer, and `pending:legacy-<i>` for one queued before sequence numbers existed. The extension also registers a display provider, so the package's `bg-work` footer describes the work instead of counting it: one timer reads `timer-1 0:42`, several read `2 timers: timer-1 0:42, timer-2 1:05`, and a running heartbeat leads with the time to its next tick (`heartbeat 4:30 · 2 timers: …`). A queued wake folds into the timer or heartbeat that owes it; a wake that cannot be attributed reads `wake queued`. Timer ids must be 1-200 as counted by the schema library that compiles the tool schema, and at most 250 UTF-16 units, with no edge whitespace and no control characters. The library's count is neither UTF-16 units nor exactly UAX #29 grapheme clusters, so the tool's 200 and the manager's 250 measure different things: an id can pass the schema and still be refused by the manager, whose refusal names the units it counts and whose 250-unit check is what keeps `timer:<id>` inside the package's 256-unit budget. The provider skips any armed id the package would still reject, so one bad id does not fail a listing.

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
