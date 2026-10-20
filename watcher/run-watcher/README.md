# run-watcher

Part of [Watcher](../../README.md). A band above the prompt shows the background tasks Claude starts, each sorted into a category (API calls, LLM run, Experiment, Tests, Build, Server, Install, Data, Script) with tags and a cost tag. Press `r` for the panel. The band hides 10 minutes after the last task finishes.

## What it touches

Watcher draws on screen only. It sends nothing anywhere, makes no network calls, starts no programs, and adds nothing to the model's context.

| Hook | What it does |
| --- | --- |
| `tool.call` (Bash) | Reads the result of a Bash call Claude made, to spot a background task's ID and output file. The call and its result pass through unchanged. |
| `prompt.submit` | Reads a task-notification (task ID, status, exit code) to mark a task done or failed, and lifts the pause key (`h`). The prompt passes through unchanged. |
| `classic.Stop`, `classic.SubagentStop` | Read the list of background tasks as a backup, so tasks started by subagents finish too. Nothing is changed. |
| `session.start`, `ui.*` | Restore the band's own state and draw the band and panel. |

**Files read:** the last few lines of a task's own output file, read with the file API. This happens only while the panel is open, or once when a task ends. Those lines provide the progress and cost tag, and they stay on screen.

**Commands:** the category words in the source (tool and package-manager names) are patterns matched against the command text, to choose a label. run-watcher never runs them.

**open log ↗:** a plain `file://` link to the output file. Your system opens it when you click it.

**Settings:** `lingerMinutes` (10), `bandRows` (2) and `extraPatterns` (your own category words).
