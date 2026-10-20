# Watcher

Quiet, live bands above the Claude Code prompt. They show what's running while it runs, then get out of the way.

**Version 0.1.0** · Claude Code 2.1.304+ · MIT

```
Context · Opus 5.5 high                                   473k / 1.0M · 47%
████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
Usage ━━━━━━━━━━━━━━━━━━━━━━──────────────  47%  resets in 16m · on pace
```

<!-- screenshots: docs/agent-watcher.png, docs/run-watcher.png, docs/context-watcher.png -->

## The plugins

| Plugin | Shows | Panel |
| --- | --- | --- |
| **agent-watcher** | Running subagents, each with a pixel crab, its model and tokens. | `a` |
| **run-watcher** | Background tasks Claude starts, sorted into API calls, LLM run, Experiment, Tests, Build, Server, Install, Data and Script, with tags, a cost tag and an "open log ↗" button. Output is read only when you expand a task. | `r` |
| **context-watcher** | The model and effort, a context bar (shimmers as it grows, reverses on compaction) and the 5-hour usage window with pace. | — |

Watcher bands stack above the context card. With two or more up, press `h` to pause them.

**Design rules:** nothing shows unless it's relevant, everything hides 10 minutes after activity, there's no flicker, and nothing is ever added to the model's context, so Watcher costs no usage.

## Install

Add the marketplace, then install any or all of the plugins:

```
/plugin marketplace add AE-Emmanuel/watcher
/plugin install agent-watcher@watcher
/plugin install run-watcher@watcher
/plugin install context-watcher@watcher
```

Then run `/reload-plugins`.

## Settings

Set these in `/plugin` → the plugin → Configure.

| Plugin | Setting | Default |
| --- | --- | --- |
| all | `lingerMinutes`: how long the band stays after activity | 10 |
| agent-, run-watcher | `bandRows`: rows shown before the rest fold into `+N` (1–4) | 2 |
| run-watcher | `extraPatterns`: your own category words, e.g. `Experiment: run_thesis; API calls: my_batch` | — |
| context-watcher | `showUsagePace`: show pace against the 5-hour window | on |

## Credits

The pixel Clawd crab and the dotted track are adapted from [savvy-progress](https://github.com/JohnnyVizz/claude-kit) by JohnnyVizz (MIT). See [LICENSE](LICENSE).
