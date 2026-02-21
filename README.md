# @marcfargas/pi-heartbeat

Non-blocking timers and heartbeats for [pi](https://github.com/badlogic/pi-mono) agents.

Stop using `sleep` — it blocks the chat. This extension lets the agent set a timer and return to idle immediately. When the timer fires, the agent wakes up with full context.

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

## Tools

### `timer` — One-shot wake-up

```
timer(seconds: 60, message: "Check if build #42 finished — run gh run view 42")
```

- Returns immediately — agent goes idle, user can chat
- When timer fires, agent is woken up with the message
- Multiple timers can be active simultaneously
- Optional `id` parameter for named timers

### `heartbeat` — Periodic ping

```
heartbeat(action: "start", interval_seconds: 30, message: "Check deploy status")
heartbeat(action: "status")
heartbeat(action: "stop")
```

- Wakes the agent every N seconds with a status check
- Only one heartbeat at a time (starting stops previous)
- Min interval: 10 seconds

### `/cancel-timer` — Manual control

```
/cancel-timer            # List active timers
/cancel-timer <id>       # Cancel specific timer
/cancel-timer heartbeat  # Stop heartbeat
/cancel-timer all        # Cancel everything
```

## How It Works

```
User: "Start the build and let me know when it's done"

Agent: calls timer(seconds: 60, message: "Check build status")
       → tool returns immediately
       → agent tells user "I'll check in 60s"
       → agent goes IDLE — user can chat freely

[60 seconds later]

⏰ Timer fires → sendMessage({ triggerTurn: true })
→ Agent wakes up: "Let me check the build..."
→ runs `gh run view 42`
→ if not done, sets another timer
```

## vs. `sleep`

|  | `sleep 60` | `timer(60)` |
|---|---|---|
| Chat blocked? | ✅ Yes | ❌ No |
| User can interact? | ❌ No | ✅ Yes |
| Cancellable? | Kill process | `/cancel-timer` |
| Multiple? | Sequential | Concurrent |
| Context? | Bash stdout | Full message |

## Development

```bash
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
```

## License

MIT
