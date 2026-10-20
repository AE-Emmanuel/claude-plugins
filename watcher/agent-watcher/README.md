# agent-watcher

Part of [Watcher](../../README.md). A band above the prompt shows each running subagent with a pixel crab, its model and tokens. Press `a` for the panel. The band hides 10 minutes after the last agent finishes.

## What it touches

Watcher draws on screen only. It sends nothing anywhere, starts no programs, reads no files, and adds nothing to the model's context.

| Hook | What it does |
| --- | --- |
| `agent.spawn` | Notes the new subagent's name, type and model for the band. The call passes through unchanged; its prompt, settings and tools are never edited. |
| `tool.call`, `turn.complete` | Read progress and token counts from subagent turns. Nothing is changed. |
| `prompt.submit` | A new prompt lifts the pause key (`h`). The prompt passes through unchanged. |
| `session.start`, `ui.*` | Restore the band's own state and draw the band and panel. |

**Settings:** `lingerMinutes` (10) and `bandRows` (2).
