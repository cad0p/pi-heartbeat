---
"@marcfargas/pi-heartbeat": patch
---

Fix: timer/heartbeat no longer crashes the pi process when the extension ctx is stale.

Previously, when a pi session was replaced (newSession/fork/switchSession/reload),
the captured extension ctx was invalidated but pending setTimeout/setInterval
callbacks still held a reference to it. The next time a timer or heartbeat fired,
`pi.sendMessage()` threw a stale-ctx error inside the timer callback, which
propagated as an uncaughtException and killed the pi process.

Now both `setTimer` and `startHeartbeat` wrap the `sendMessage` call in try/catch.
The one-shot timer swallows the error (it was about to delete itself anyway).
The periodic heartbeat calls `stopHeartbeat()` on error so a stale ctx doesn't
leave a zombie interval throwing on every tick.
