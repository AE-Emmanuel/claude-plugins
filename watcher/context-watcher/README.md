# context-watcher

Part of [Watcher](../../README.md). A card above the prompt shows the model and its effort, a context bar (it shimmers as context grows and runs backwards on compaction), and the 5-hour usage window with pace. The card hides 10 minutes after a turn ends.

## What it touches

Watcher draws on screen only. It sends nothing anywhere, starts no programs, reads no files, holds no credentials, and adds nothing to the model's context.

| Hook | What it does |
| --- | --- |
| `session.measure` | Reads context size and the usage-window percentage that Claude Code already reports. Nothing is changed. |
| `turn.step` | Reads the effort level of the main loop and of subagents. The step passes through unchanged. |
| `agent.spawn` | Notes a subagent's model for the model carousel. The call passes through unchanged. |
| `prompt.submit` | Brings the card up and lifts the pause key (`h`). The prompt passes through unchanged. |
| `session.start`, `turn.complete`, `ui.*` | Restore and draw the card. |

**Settings:** `lingerMinutes` (10) and `showUsagePace` (on).
