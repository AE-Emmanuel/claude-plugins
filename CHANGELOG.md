# Changelog

## 0.1.0 — 2026-10-20

First release of Watcher, in the `ae-plugins` marketplace. Three plugins, each installable on its own:

- **agent-watcher** — running subagents with pixel crabs, model and tokens; panel on `a`.
- **run-watcher** — background tasks Claude starts, sorted into categories (API calls, LLM run, Experiment, Tests, Build, Server, Install, Data, Script) with tags, cost and an "open log" button; panel on `r`.
- **context-watcher** — model and effort, a context bar with growth and compaction shimmers, and the 5-hour usage window with pace.

All bands stack above the context card, hide 10 minutes after activity, and add nothing to the model's context.
