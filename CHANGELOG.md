# Changelog

All notable changes to this project will be documented in this file.

## [calver-released]

<!-- USER-EDITABLE SECTION START -->
<!-- Add your curated release notes here. -->
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- Declare engines node >=22.19.0 (pi's minimum) ([#6](https://github.com/cad0p/pi-heartbeat/pull/6))
- Armed timers and heartbeat survive /reload (closes #8) ([#9](https://github.com/cad0p/pi-heartbeat/pull/9))
- Report armed timers and the heartbeat as background work (closes #11) ([#12](https://github.com/cad0p/pi-heartbeat/pull/12))
- Describe armed timers and the heartbeat in the background-work footer (closes #13) ([#14](https://github.com/cad0p/pi-heartbeat/pull/14))
- *(timer)* Armed work survives a crash, and an overdue timer wakes once (closes #7) ([#18](https://github.com/cad0p/pi-heartbeat/pull/18))

### 🐛 Bug Fixes

- *(timer)* Refuse ids the consumer cannot list, and clear the #10 follow-ups (closes #10) ([#15](https://github.com/cad0p/pi-heartbeat/pull/15))
- *(timer)* Say what the limit counts, and pin the dependency range (closes #16) ([#19](https://github.com/cad0p/pi-heartbeat/pull/19))
- *(timer)* Keep the limit message true under any typebox measure (closes #20) ([#21](https://github.com/cad0p/pi-heartbeat/pull/21))


