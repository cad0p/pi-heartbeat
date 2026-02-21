---
name: pi-heartbeat
description: >-
  Non-blocking timers and heartbeats for pi agents. Use instead of `sleep` when waiting
  for builds, deployments, CI pipelines, or any async process. The agent returns to idle
  immediately and gets woken up when the timer fires.
  Triggers: timer, heartbeat, wait for build, poll, cron, wake me up, non-blocking wait,
  check back later, monitor deployment, periodic check.
---

# Heartbeat & Timer Tools

2 tools for non-blocking waiting. Stop using `sleep` — it blocks the chat.

## Tools

| Tool | Purpose |
|------|---------|
| `timer` | One-shot "wake me up in N seconds" with a context message |
| `heartbeat` | Periodic "ping me every N seconds" (start/stop/status) |

## When to Use

| Scenario | Before (blocks chat) | After (non-blocking) |
|----------|---------------------|---------------------|
| Wait for build | `sleep 60 && gh run view 42` | `timer(60, "Check build #42")` |
| Monitor deploy | `while true; do sleep 30; check; done` | `heartbeat(start, 30, "Check deploy")` |
| Rate-limited API | `sleep 10` between calls | `timer(10, "Resume API calls")` |

## How It Works

1. Agent calls `timer` or `heartbeat` — tool returns **immediately**
2. Agent finishes response, goes idle — **user can chat freely**
3. When timer fires, a message is injected via `sendMessage({ triggerTurn: true })`
4. Agent wakes up with full context of what it was waiting for
5. Agent acts (check status, retry, etc.) — can set another timer if needed

## Timer

```
timer(seconds: 60, message: "Check if build #42 finished — run gh run view 42")
```

- Returns immediately with timer ID
- Multiple timers can be active simultaneously
- Optional `id` parameter for named timers (enables cancellation)
- Max 3600 seconds (1 hour)

## Heartbeat

```
heartbeat(action: "start", interval_seconds: 30, message: "Check deploy status")
heartbeat(action: "status")
heartbeat(action: "stop")
```

- Only one heartbeat active at a time (starting a new one stops the previous)
- Min interval: 10 seconds
- Tracks tick count for monitoring duration

## Commands

| Command | Description |
|---------|-------------|
| `/cancel-timer` | List active timers and heartbeat |
| `/cancel-timer <id>` | Cancel a specific timer |
| `/cancel-timer heartbeat` | Stop the heartbeat |
| `/cancel-timer all` | Cancel everything |

## Best Practices

- **Include actionable context** in the message: what to check, what command to run
- **Set reasonable intervals** — don't heartbeat every 10s for a 30-minute deploy
- **Stop heartbeats** when done — they keep firing until stopped
- **Chain timers** for progressive backoff: check at 30s, then 60s, then 120s
