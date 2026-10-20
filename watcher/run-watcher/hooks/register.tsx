// Run watcher (part of Watcher): the background tasks Claude starts, each named by its category and
// tags, with a sweep while it runs and a filled or failed track when it ends. Output files are read
// only when they are shown (the panel is open, or once when a task ends), never on a timer behind
// your back, and nothing here reaches the model.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { RunRow } from '../types'

// Set from the plugin's settings when it loads (see plugin.json userConfig).
let LINGER_MS = 10 * 60 * 1000
let BAND_ROWS = 2
// Extra command patterns per category, from settings: "Experiment: run_thesis; API calls: my_batch".
let EXTRA: { name: string; match: RegExp }[] = []
const PANE = 'run-watcher-list'
const CHIP_COLS = 8
const CHIP_PX = CHIP_COLS * 8 + 16
// A new task reads "Background task" for this long before its category takes over.
const INTRO_MS = 1200
const PANEL_REFRESH_MS = 3000
const TAIL_LINES = 6

// The last few non-blank lines of a task's output file, read directly (no program is started).
async function lastLines($: { fs: { read: (path: string) => Promise<unknown> } }, path: string): Promise<string[] | null> {
  const text = await $.fs.read(path).catch(() => null)
  return typeof text === 'string' ? text.split('\n').filter(l => l.trim()).slice(-TAIL_LINES) : null
}

const rows = atom({ plugin: 'run-watcher', key: 'rows' } as const, [] as RunRow[])
const tick = atom({ plugin: 'run-watcher', key: 'tick' } as const, 0)
const isPanelOpen = atom({ plugin: 'run-watcher', key: 'isPanelOpen' } as const, false)
// The pause key (h, in any Watcher band) hides every band until the next prompt.
const isPaused = atom({ plugin: 'run-watcher', key: 'isPaused' } as const, false)

// ---------------------------------------------------------------------------
// Categories: what a task is, from its command and the description Claude gave it. Each has a
// color and tag rules that say what is happening inside it (provider, kind of run, tool).

type Category = { name: string; color: string; match: RegExp; tags: [RegExp, string][] }

const CATEGORIES: Category[] = [
  {
    name: 'API calls',
    color: '#D97757',
    match: /\b(anthropic|openai|gemini|claude|gpt|mistral|cohere|groq|together|openrouter|bedrock|vertex|api|batch(es)?|requests|httpx|http)\b|https?:\/\//i,
    tags: [
      [/anthropic|claude/i, 'anthropic'],
      [/openai|gpt/i, 'openai'],
      [/gemini|vertex/i, 'gemini'],
      [/openrouter/i, 'openrouter'],
      [/bedrock/i, 'bedrock'],
      [/batch/i, 'batch'],
      [/eval|judge|grade|score/i, 'eval'],
      [/generat|synth|complet/i, 'generate'],
      [/embed/i, 'embeddings'],
      [/scrap|crawl/i, 'scrape'],
    ],
  },
  {
    name: 'LLM run',
    color: '#8F8CF4',
    match: /\b(train|training|finetun\w*|fine-tun\w*|lora|qlora|sft|dpo|rlhf|infer\w*|vllm|ollama|llama\.?cpp|torchrun|accelerate|deepspeed|transformers|unsloth|mlx_lm)\b/i,
    tags: [
      [/finetun|fine-tun|sft|lora|qlora|unsloth/i, 'fine-tuning'],
      [/\btrain/i, 'training'],
      [/dpo|rlhf|ppo|grpo/i, 'preference'],
      [/infer|generate|serve/i, 'inference'],
      [/ollama/i, 'ollama'],
      [/vllm/i, 'vllm'],
      [/llama\.?cpp/i, 'llama.cpp'],
      [/mlx/i, 'mlx'],
      [/torchrun|accelerate|deepspeed/i, 'distributed'],
    ],
  },
  {
    name: 'Experiment',
    color: '#D65DB1',
    match: /\b(experiment|exp_|run_exp|sweep|ablation|benchmark|bench|eval\w*|simulat\w*|sim|carla|gazebo|ros2?|wandb|mlflow|optuna)\b/i,
    tags: [
      [/sweep|optuna|grid/i, 'sweep'],
      [/ablation/i, 'ablation'],
      [/bench/i, 'benchmark'],
      [/eval/i, 'eval'],
      [/simulat|\bsim\b|carla|gazebo|ros/i, 'simulation'],
      [/wandb|mlflow/i, 'tracked'],
    ],
  },
  {
    name: 'Tests',
    color: '#3B9C5F',
    match: /\b(pytest|unittest|jest|vitest|mocha|cargo test|go test|npm (run )?test|pnpm test|yarn test|tox|nox|test)\b/i,
    tags: [
      [/pytest|unittest|tox|nox/i, 'python'],
      [/jest|vitest|mocha|npm|pnpm|yarn/i, 'js'],
      [/cargo/i, 'rust'],
      [/go test/i, 'go'],
      [/integration|e2e/i, 'integration'],
      [/unit/i, 'unit'],
      [/coverage|--cov/i, 'coverage'],
    ],
  },
  {
    name: 'Build',
    color: '#E0703A',
    match: /\b(make|cmake|ninja|docker (build|compose)|npm run build|pnpm build|yarn build|cargo build|gradle|mvn|xcodebuild|tsc|webpack|vite build)\b/i,
    tags: [
      [/docker/i, 'docker'],
      [/cmake|make|ninja/i, 'native'],
      [/npm|pnpm|yarn|vite|webpack|tsc/i, 'js'],
      [/cargo/i, 'rust'],
      [/xcodebuild/i, 'xcode'],
    ],
  },
  {
    name: 'Server',
    color: '#5B8DEF',
    match: /\b(dev|serve|server|uvicorn|gunicorn|flask|fastapi|django|runserver|http\.server|jupyter|streamlit|gradio|next dev|vite)\b/i,
    tags: [
      [/uvicorn|fastapi/i, 'fastapi'],
      [/flask/i, 'flask'],
      [/django|runserver/i, 'django'],
      [/jupyter/i, 'jupyter'],
      [/streamlit|gradio/i, 'ui'],
      [/next|vite|npm|pnpm/i, 'js'],
    ],
  },
  {
    name: 'Install',
    color: '#9A9A96',
    match: /\b(pip3? install|uv (pip|sync|add)|poetry install|conda (install|create)|npm (i|install|ci)|pnpm (i|install)|yarn( install)?|brew install|apt(-get)? install|cargo install)\b/i,
    tags: [
      [/pip|uv |poetry/i, 'python'],
      [/conda/i, 'conda'],
      [/npm|pnpm|yarn/i, 'js'],
      [/brew/i, 'brew'],
      [/apt/i, 'apt'],
    ],
  },
  {
    name: 'Data',
    color: '#3FA7D6',
    match: /\b(download|rsync|scp|aws s3|gsutil|huggingface-cli|hf download|preprocess\w*|etl|convert|extract|dataset|unzip|tar)\b/i,
    tags: [
      [/download|huggingface|hf download/i, 'download'],
      [/rsync|scp|s3|gsutil/i, 'sync'],
      [/preprocess|etl|convert|clean/i, 'preprocess'],
      [/unzip|tar|extract/i, 'extract'],
    ],
  },
]

const SCRIPT: Category = {
  name: 'Script',
  color: '#E0A526',
  match: /.*/,
  tags: [
    [/\bpython3?\b|\.py\b/i, 'python'],
    [/\bnode\b|\.m?js\b|\bnpx\b/i, 'node'],
    [/\bbash\b|\.sh\b|\bzsh\b/i, 'shell'],
  ],
}

const categoryOf = (name: string) => CATEGORIES.find(c => c.name === name) ?? SCRIPT

const classify = (command: string, description: string) => {
  const text = `${command} ${description}`
  const extra = EXTRA.find(x => x.match.test(text))
  const category = (extra && CATEGORIES.find(c => c.name === extra.name)) || CATEGORIES.find(c => c.match.test(text)) || SCRIPT
  const tags = [...new Set(category.tags.filter(([re]) => re.test(text)).map(([, tag]) => tag))].slice(0, 3)
  return { category: category.name, tags }
}

// Progress from a log's last lines: a percentage (tqdm "45%"), else a count ("epoch 3/10").
const percentOf = (lines: string[]) => {
  for (const line of [...lines].reverse()) {
    const pct = [...line.matchAll(/(\d{1,3}(?:\.\d+)?)\s?%/g)].map(m => Number(m[1])).filter(n => n >= 0 && n <= 100)
    if (pct.length) {
      return pct[pct.length - 1] ?? null
    }
    const count = /\b(\d+)\s?\/\s?(\d+)\b/.exec(line)
    if (count) {
      const a = Number(count[1])
      const b = Number(count[2])
      if (b > 1 && a <= b) {
        return (100 * a) / b
      }
    }
  }
  return null
}

// What an API run spent, when its log prints it: the last token count and dollar cost seen.
const spendOf = (lines: string[]) => {
  const text = lines.join('\n')
  const tokens = [...text.matchAll(/([\d][\d,]*(?:\.\d+)?)\s*([kKmM])?\s*(?:total\s+)?tokens/g)].pop()
  const cost = [...text.matchAll(/\$\s?(\d+(?:\.\d+)?)/g)].pop()
  const n = tokens ? Number((tokens[1] ?? '').replace(/,/g, '')) * (/k/i.test(tokens[2] ?? '') ? 1e3 : /m/i.test(tokens[2] ?? '') ? 1e6 : 1) : null
  const tok = n === null || !Number.isFinite(n) ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M tokens` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k tokens` : `${n} tokens`
  const usd = cost ? `$${Number(cost[1]).toFixed(2)}` : ''
  return [tok, usd].filter(Boolean).join(' · ') || null
}

// The path Claude Code writes a background command's output to, as its result names it.
const outputPathOf = (text: string) => /(\/[^\s'"`]+\.(?:output|log|txt))/.exec(text)?.[1] ?? null

// ---------------------------------------------------------------------------
// Drawing (savvy-progress style; shared look with agent watcher).

const DONE = '#3B9C5F'
const FAILED = '#D0453F'
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"
const MONO = "'SF Mono',ui-monospace,Menlo,monospace"

const xml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const textWidth = (s: string, size: number) =>
  [...s].reduce((w, ch) => w + (/[\s.,:;'|!il1()]/.test(ch) ? 0.3 : /[A-Zmw@%]/.test(ch) ? 0.72 : 0.56) * size, 0)

const fitText = (s: string, size: number, maxW: number) => {
  if (textWidth(s, size) <= maxW) {
    return s
  }
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) {
      break
    }
    out += ch
  }
  return out + '…'
}

const formatElapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) {
    return `${s}s`
  }
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

// The Watcher track: a thin pixel bar adapted from savvy-progress by JohnnyVizz (MIT,
// github.com/JohnnyVizz/claude-kit). Cells sit on a fixed noise pattern and only twinkle in
// opacity, in four out-of-phase groups: nothing moves, nothing is blurred, so it never jitters,
// and its source changes only with the status. The band never shows progress: running twinkles
// across the whole width, done settles to a slow glow, failed is a still red bar. Only an expanded
// panel passes a real percentage (2% or more), and the pixels then fill up to it.
const noise = (x: number, y: number) => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}
const CELL = 3

const glowTrack = (id: string, x: number, y: number, w: number, color: string, status: 'running' | 'done' | 'failed', percent: number | null = null) => {
  const tint = status === 'failed' ? FAILED : color
  const cols = Math.floor(w / CELL)
  const isProgress = percent !== null && percent >= 2 && status === 'running'
  const shown = isProgress ? Math.round((cols * Math.min(100, percent as number)) / 100) : cols
  // Running: dots on a fixed noise pattern; finished, failed or real progress: every dot lit.
  const density = status === 'running' && !isProgress ? 0.62 : 1
  const cells: string[] = []
  for (let c = 0; c < shown; c++) {
    for (let r = 0; r < 2; r++) {
      if (noise(c, r) < density) {
        cells.push(`<rect class="t${Math.floor(noise(r, c) * 4)}" x="${x + c * CELL}" y="${y - 1 + r * CELL}" width="2" height="2"/>`)
      }
    }
  }
  const rest = shown < cols ? `<rect class="k" x="${x + shown * CELL}" y="${y + 0.5}" width="${w - shown * CELL}" height="2" rx="1"/>` : ''
  const mode = status === 'running' ? (isProgress ? 'pg' : 'tw') : status === 'done' ? 'tw-done' : 'still'
  return `${rest}<g class="${mode}" fill="${tint}" data-id="${id}">${cells.join('')}</g>`
}

// Opacity only, on one image whose source never changes while it runs, so nothing jitters. The
// dots breathe slowly in four out-of-phase groups (3.6–5.2 s, never below 45%), calm rather than
// flickery. Done: every dot lit with a slow glow. Failed: every dot lit red, still.
// Panel bars: the same dots over a soft, still glow in the bar's color. The glow covers the lit part
// (all of it, or up to the real percentage), never moves, so it reads as light, not flicker.
const halo = (id: string, x: number, y: number, w: number, color: string, status: 'running' | 'done' | 'failed', percent: number | null) => {
  const tint = status === 'failed' ? FAILED : color
  const lit = percent !== null && percent >= 2 && status === 'running' ? (w * Math.min(100, percent)) / 100 : w
  const strength = status === 'running' ? 0.45 : status === 'done' ? 0.55 : 0.35
  return `<defs><filter id="h${id}" x="-5%" y="-150%" width="110%" height="400%"><feGaussianBlur stdDeviation="2.2"/></filter></defs>
<rect x="${x}" y="${y - 1}" width="${lit}" height="5" rx="2.5" fill="${tint}" opacity="${strength}" filter="url(#h${id})"/>`
}

const TWINKLE_CSS = `.tw .t0,.tw .t1,.tw .t2,.tw .t3{animation:tw 4.2s ease-in-out infinite}
.tw .t1{animation-duration:5.2s;animation-delay:-1.3s}.tw .t2{animation-duration:3.6s;animation-delay:-2.4s}.tw .t3{animation-duration:4.8s;animation-delay:-.8s}
.tw-done{animation:twd 4.8s ease-in-out infinite}
@keyframes tw{0%,100%{opacity:1}50%{opacity:.45}}@keyframes twd{0%,100%{opacity:1}50%{opacity:.78}}
@media (prefers-reduced-motion: reduce){.tw rect,.tw-done{animation:none}}`

const BASE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}.mono{fill:#55554f}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}.mono{fill:#b9b9b4}}
.sweep{animation:sw 2s ease-in-out infinite}@keyframes sw{0%{transform:translateX(-30%)}100%{transform:translateX(130%)}}
.live{animation:p 1s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
.cur{animation:cb 1s steps(1) infinite}@keyframes cb{50%{opacity:0}}
.fill{transform-box:fill-box;transform-origin:left;animation:gr .6s ease-out 1}@keyframes gr{from{transform:scaleX(0)}}
.glow{animation:gw 2.4s ease-in-out infinite}@keyframes gw{50%{opacity:.25}}
.fail{animation:fl .45s ease-in-out 3}@keyframes fl{50%{opacity:.25}}
.in{animation:fi .5s ease-out 1}@keyframes fi{from{opacity:0;transform:translateY(3px)}}
@media (prefers-reduced-motion: reduce){.sweep,.live,.cur,.fill,.fail,.glow,.in{animation:none}}
${TWINKLE_CSS}
</style>`

const svg = (W: number, H: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${BASE_CSS}${body}</svg>`

// The task's mark: a rounded tile in its category color with a prompt chevron and a cursor that
// blinks while it runs. Its source changes only with the status, so the blink never restarts.
const icon = (x: number, y: number, row: RunRow, size: number) => {
  const color = row.status === 'failed' ? FAILED : categoryOf(row.category).color
  const s = size / 24
  const cursor = row.status === 'running' ? `<rect class="cur" x="13" y="14" width="6" height="2" rx="1" fill="#fff"/>` : ''
  const badge =
    row.status === 'failed'
      ? `<path d="M15 13l4 4M19 13l-4 4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>`
      : row.status === 'done'
        ? `<path d="M13.5 15l2 2 3.5-4" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
        : cursor
  return `<g transform="translate(${x},${y}) scale(${s})"><rect width="24" height="24" rx="6" fill="${color}"/>
<path d="M6 8l4 4-4 4" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>${badge}</g>`
}


const track = (id: string, x: number, y: number, w: number, row: RunRow, percent: number | null) =>
  glowTrack(id, x, y, w, categoryOf(row.category).color, row.status, percent)

const tagPills = (x: number, y: number, row: RunRow, maxW: number) => {
  const color = categoryOf(row.category).color
  let out = ''
  let cx = x
  for (const tag of row.tags) {
    const w = textWidth(tag, 10.5) + 12
    if (cx + w - x > maxW) {
      break
    }
    out += `<rect x="${cx}" y="${y - 11}" width="${w}" height="15" rx="7.5" fill="${color}" fill-opacity=".16"/>
<text x="${cx + 6}" y="${y}" font-family="${FONT}" font-size="10.5" fill="${color}">${xml(tag)}</text>`
    cx += w + 4
  }
  return { svg: out, width: cx - x }
}

const pillsWidth = (row: RunRow) => row.tags.reduce((w, tag) => w + textWidth(tag, 10.5) + 16, 0)

// The label: "Background task" while a task is new, then its category; the change fades in once.
const labelOf = (row: RunRow, now: number) => (now - row.startedAt < INTRO_MS ? 'Background task' : row.category)
const isLabelFresh = (row: RunRow, now: number) => {
  const age = now - row.startedAt
  return age >= INTRO_MS && age < INTRO_MS + 1000
}

// The band never shows progress (its track is animation only); the percentage lives in the panel.
const statsOf = (row: RunRow, now: number, keep: number, isBand = false) =>
  [
    { rank: 1, text: row.category === 'API calls' ? (spendOf(row.tail) ?? '') : '' },
    { rank: 0, text: formatElapsed((row.endedAt ?? now) - row.startedAt) },
    { rank: 1, text: isBand || row.percent === null ? '' : `${Math.round(row.percent)}%` },
    { rank: 2, text: row.status === 'failed' && row.exitCode !== null ? `exit ${row.exitCode}` : '' },
  ]
    .filter(p => p.text && p.rank < keep)
    .map(p => p.text)
    .join(' · ')

// One band row's text: label, tags, description; stats on the right. Respaces to its width: tags
// go first, then the description, then the label truncates.
const bandTextSvg = (W: number, row: RunRow, now: number, more: number) => {
  const color = row.status === 'failed' ? FAILED : categoryOf(row.category).color
  const label = labelOf(row, now)
  const right = statsOf(row, now, 3, true) + (more > 0 ? `   +${more}` : '')
  const rightW = textWidth(right, 11.5)
  const room = W - 32 - rightW - 28
  const name = fitText(label, 12.5, Math.max(40, room))
  const nameW = textWidth(name, 12.5) + 8
  const showTags = label === row.category && room - nameW - pillsWidth(row) >= 90
  const pills = showTags ? tagPills(nameW, 13, row, room - nameW) : { svg: '', width: 0 }
  const descX = nameW + (pills.width ? pills.width + 4 : 0)
  const descW = room - descX
  const desc = row.description && descW >= 48 ? fitText(row.description, 12, descW) : ''
  const fresh = isLabelFresh(row, now) ? ' class="in"' : ''
  const mark = row.status === 'running' ? `<circle class="live" cx="${W - 37}" cy="9" r="3" fill="${color}"/>` : ''
  return svg(
    W - 32,
    18,
    `<g${fresh}><text x="0" y="13" font-family="${FONT}" font-size="12.5" font-weight="600" fill="${color}">${xml(name)}</text>${pills.svg}</g>
<text class="s" x="${descX}" y="13" font-family="${FONT}" font-size="12">${xml(desc)}</text>
<text class="s" x="${W - 46}" y="13" text-anchor="end" font-family="${FONT}" font-size="11.5" font-variant-numeric="tabular-nums">${xml(right)}</text>${mark}`,
  )
}

const bandTrackSvg = (W: number, row: RunRow) => svg(W - 32, 8, track(row.id, 0, 2, W - 32, row, null))
const bandIconSvg = (row: RunRow) => svg(28, 28, icon(2, 4, row, 20))

const headerSvg = (W: number, all: RunRow[]) => {
  const running = all.filter(r => r.status === 'running').length
  const failed = all.filter(r => r.status === 'failed').length
  const gap = 6
  const tw = (W - gap * 2) / 3
  const tile = (i: number, k: string, v: string, color?: string) =>
    `<rect class="tile" x="${i * (tw + gap)}" y="0" width="${tw}" height="40" rx="8"/>
<text class="s" x="${i * (tw + gap) + 9}" y="16" font-family="${FONT}" font-size="11">${k}</text>
<text ${color ? `fill="${color}"` : 'class="t"'} x="${i * (tw + gap) + 9}" y="33" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  return svg(W, 44, tile(0, 'Running', `${running}`) + tile(1, 'Finished', `${all.length - running - failed}`) + tile(2, 'Failed', `${failed}`, failed ? FAILED : undefined))
}

// A panel card: label and tags, description, the command, stats, the track (a real fill when the
// log shows a percentage) and the last output lines.
const paneTextSvg = (W: number, row: RunRow, now: number) => {
  const w = W - 44
  const color = row.status === 'failed' ? FAILED : categoryOf(row.category).color
  const name = fitText(row.category, 13, w * 0.5)
  const nameW = textWidth(name, 13) + 8
  const pills = tagPills(nameW, 16, row, w - nameW - 70)
  const stats = statsOf(row, now, 3)
  return svg(
    w,
    58,
    `<text x="0" y="16" font-family="${FONT}" font-size="13" font-weight="600" fill="${color}">${xml(name)}</text>${pills.svg}
<text class="s" x="${w - 4}" y="16" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(stats)}</text>
<text class="t" x="0" y="34" font-family="${FONT}" font-size="12">${xml(fitText(row.description || 'Background task', 12, w - 4))}</text>
<text class="mono" x="0" y="51" font-family="${MONO}" font-size="10.5">${xml(fitText(`$ ${row.command}`, 10.5, w - 4))}</text>`,
  )
}

const paneTrackSvg = (W: number, row: RunRow) =>
  svg(W - 44, 14, `${halo(`p${row.id}`, 0, 5, W - 52, categoryOf(row.category).color, row.status, row.status === 'running' ? row.percent : null)}${track(`p${row.id}`, 0, 5, W - 52, row, row.status === 'running' ? row.percent : null)}`)

const paneTailSvg = (W: number, row: RunRow) => {
  const w = W - 44
  const lines = row.tail.slice(-TAIL_LINES)
  const H = lines.length * 14 + 12
  return svg(
    w,
    H,
    `${lines.map((l, i) => `<text class="mono" x="0" y="${12 + i * 14}" font-family="${MONO}" font-size="10">${xml(fitText(l, 10, w - 4))}</text>`).join('')}
<line class="ln" x1="0" y1="${H - 0.5}" x2="${w}" y2="${H - 0.5}"/>`,
  )
}
const paneIconSvg = (row: RunRow) => svg(44, 44, icon(4, 8, row, 28))

// Terminal fallback: a colored mark, a block bar and plain text.
const barText = (row: RunRow, t: number, width: number) => {
  if (row.status !== 'running') {
    return '█'.repeat(width)
  }
  const span = width * 2 - 2
  const pos = t % span
  const head = pos < width ? pos : span - pos
  return Array.from({ length: width }, (_, i) => {
    const d = Math.abs(i - head)
    return d === 0 ? '█' : d === 1 ? '▓' : d === 2 ? '▒' : '░'
  }).join('')
}

const ordered = (all: RunRow[]) =>
  [...all].sort((a, b) => {
    const aRunning = a.status === 'running'
    const bRunning = b.status === 'running'
    if (aRunning !== bRunning) {
      return aRunning ? -1 : 1
    }
    return b.startedAt - a.startedAt
  })

// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  LINGER_MS = Math.max(1, Number(options.lingerMinutes ?? 10)) * 60 * 1000
  BAND_ROWS = Math.max(1, Math.min(4, Number(options.bandRows ?? 2)))
  EXTRA = String(options.extraPatterns ?? '')
    .split(';')
    .map(part => part.split(':'))
    .filter(([name, words]) => name && words)
    .map(([name, words]) => ({
      name: (name ?? '').trim(),
      match: new RegExp(`(${(words ?? '').split(',').map(w => w.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean).join('|')})`, 'i'),
    }))
    .filter(x => x.match.source !== '()')

  let pulse: { cancel: () => void } | null = null
  let clear: { cancel: () => void } | null = null
  let refresh: { cancel: () => void } | null = null

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      const all = await read($, rows)
      if (all.some(r => r.status === 'running')) {
        pulse = $.clock.every(1000, () => {
          void update($, tick, t => t + 1).catch(() => {})
        })
      } else if (all.length > 0) {
        clear = $.clock.after(LINGER_MS, () => {
          clear = null
          void update($, rows, list => list.filter(r => r.status === 'running')).catch(() => {})
          void update($, isPanelOpen, () => false).catch(() => {})
          void $.ui.close({ id: PANE }).catch(() => {})
        })
      }
    } catch {}
    return result
  })

  // A Bash call that went to the background (asked for, ctrl+b, or a timeout) becomes a task.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    try {
      const out = result.result as { backgroundTaskId?: string } | undefined
      const id = out?.backgroundTaskId
      if (id) {
        const command = e.command.trim()
        const description = e.description ?? ''
        const row: RunRow = {
          id,
          command,
          description,
          ...classify(command, description),
          startedAt: await $.clock.now(),
          endedAt: null,
          status: 'running',
          exitCode: null,
          outputPath: outputPathOf(result.text ?? ''),
          percent: null,
          tail: [],
        }
        clear?.cancel()
        clear = null
        await update($, rows, all => [...all.filter(r => r.id !== id), row])
        // Only the elapsed time ticks; the sweep and cursor animate in CSS.
        if (!pulse) {
          pulse = $.clock.every(1000, () => {
            void update($, tick, t => t + 1).catch(() => {})
          })
        }
      }
    } catch {}
    return result
  }).catch(($, e, next) => next(e)) // display only: a failure never blocks Claude Code

  on('ui.press', { element: 'watcher-pause' }, async ($, e, next) => {
    await update($, isPaused, () => true).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e))

  // A background task ended: Claude Code tells the session with a task notification.
  on('prompt.submit', async ($, e, next) => {
    try {
      if (e.origin?.kind !== 'task-notification') {
        await update($, isPaused, () => false)
      }
      if (e.origin?.kind === 'task-notification') {
        const id = /<task-id>([^<]+)<\/task-id>/.exec(e.text)?.[1]?.trim()
        const status = /<status>([^<]+)<\/status>/.exec(e.text)?.[1]?.trim() ?? ''
        const code = /exit(?:ed with)? code[:\s]+(-?\d+)/i.exec(e.text)?.[1]
        const path = /<output-file>([^<]+)<\/output-file>/.exec(e.text)?.[1]?.trim()
        const all = await read($, rows)
        const row = all.find(r => r.id === id)
        if (row && row.status === 'running') {
          const exitCode = code === undefined ? null : Number(code)
          const isFailed = /fail|kill|error|stop/i.test(status) || (exitCode !== null && exitCode !== 0)
          const now = await $.clock.now()
          // Read its output once now that it has ended, for the final line and percentage.
          let tail = row.tail
          const file = path ?? row.outputPath
          if (file) {
            const r = await lastLines($, file)
            if (r) {
              tail = r
            }
          }
          const percent = percentOf(tail)
          await update($, rows, list =>
            list.map(x =>
              x.id === row.id
                ? { ...x, status: (isFailed ? 'failed' : 'done') as RunRow['status'], exitCode, endedAt: now, tail, percent: isFailed ? percent : (percent ?? 100), outputPath: file ?? null }
                : x,
            ),
          )
          if (!(await read($, rows)).some(r => r.status === 'running')) {
            pulse?.cancel()
            pulse = null
            clear?.cancel()
            clear = $.clock.after(LINGER_MS, () => {
              clear = null
              void update($, rows, list => list.filter(r => r.status === 'running')).catch(() => {})
              void update($, isPanelOpen, () => false).catch(() => {})
              void $.ui.close({ id: PANE }).catch(() => {})
            })
          }
        }
      }
    } catch {}
    return next(e)
  }).catch(($, e, next) => next(e)) // display only: a failure never blocks Claude Code

  // A task a subagent started tells that subagent when it ends, not this session. Every time the
  // session or a subagent stops, Claude Code lists the background work still in flight: a running
  // row that is no longer listed has ended (its exit code is unknown, so it is shown as finished).
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    try {
      const live = (e as { background_tasks?: { id: string }[] }).background_tasks
      if (Array.isArray(live)) {
        const ids = new Set(live.map(t => t.id))
        const now = await $.clock.now()
        const ended = (await read($, rows)).filter(r => r.status === 'running' && !ids.has(r.id) && now - r.startedAt > 3000)
        for (const r of ended) {
          let tail = r.tail
          if (r.outputPath) {
            const res = await lastLines($, r.outputPath)
            if (res) {
              tail = res
            }
          }
          await update($, rows, xs => xs.map(x => (x.id === r.id ? { ...x, status: 'done' as RunRow['status'], endedAt: now, tail, percent: percentOf(tail) ?? 100 } : x)))
        }
        if (ended.length && !(await read($, rows)).some(r => r.status === 'running')) {
          pulse?.cancel()
          pulse = null
          clear?.cancel()
          clear = $.clock.after(LINGER_MS, () => {
            clear = null
            void update($, rows, list => list.filter(r => r.status === 'running')).catch(() => {})
            void update($, isPanelOpen, () => false).catch(() => {})
            void $.ui.close({ id: PANE }).catch(() => {})
          })
        }
      }
    } catch {}
    return result
  }).catch(($, e, next) => next(e))
  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)
    try {
      const live = (e as { background_tasks?: { id: string }[] }).background_tasks
      if (Array.isArray(live)) {
        const ids = new Set(live.map(t => t.id))
        const now = await $.clock.now()
        const ended = (await read($, rows)).filter(r => r.status === 'running' && !ids.has(r.id) && now - r.startedAt > 3000)
        for (const r of ended) {
          let tail = r.tail
          if (r.outputPath) {
            const res = await lastLines($, r.outputPath)
            if (res) {
              tail = res
            }
          }
          await update($, rows, xs => xs.map(x => (x.id === r.id ? { ...x, status: 'done' as RunRow['status'], endedAt: now, tail, percent: percentOf(tail) ?? 100 } : x)))
        }
        if (ended.length && !(await read($, rows)).some(r => r.status === 'running')) {
          pulse?.cancel()
          pulse = null
          clear?.cancel()
          clear = $.clock.after(LINGER_MS, () => {
            clear = null
            void update($, rows, list => list.filter(r => r.status === 'running')).catch(() => {})
            void update($, isPanelOpen, () => false).catch(() => {})
            void $.ui.close({ id: PANE }).catch(() => {})
          })
        }
      }
    } catch {}
    return result
  }).catch(($, e, next) => next(e))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      refresh?.cancel()
      refresh = null
      await update($, isPanelOpen, () => false).catch(() => {})
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // display only: a failure never blocks Claude Code

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const all = await read($, rows)
    if (e.props.hasSurvey || all.length === 0 || (await read($, isPanelOpen)) || (await read($, isPaused))) {
      return next(e)
    }
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const t = await read($, tick)
    // Whole seconds: within a second the text images come out identical.
    const now = Math.floor((await $.clock.now()) / 1000) * 1000
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const shown = ordered(all).slice(0, BAND_ROWS)
    const more = all.length - shown.length
    // Expanding reads the running tasks' output now and every few seconds while the panel is open.
    const openPanel = async () => {
      await update($, isPanelOpen, () => true)
      await $.ui.open({ id: PANE, title: 'Background tasks' })
      const readTails = async () => {
        const list = await read($, rows)
        for (const r of list.filter(x => x.status === 'running' && x.outputPath)) {
          const res = await lastLines($, r.outputPath)
          if (res) {
            const tail = res
            await update($, rows, xs => xs.map(x => (x.id === r.id ? { ...x, tail, percent: percentOf(tail) } : x)))
          }
        }
      }
      await readTails().catch(() => {})
      refresh?.cancel()
      refresh = $.clock.every(PANEL_REFRESH_MS, () => {
        void (async () => {
          if (!(await read($, isPanelOpen))) {
            refresh?.cancel()
            refresh = null
            return
          }
          await readTails()
        })().catch(() => {})
      })
    }

    // The pause key shows only when another Watcher band is up too, once, in this band's second
    // row's free chip slot, so it never crowds the open button.
    const showPause = below !== null && !hasKey(below, 'watcher-pause')

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(200, Math.min(1400, (e.props.bodyColumns || 100) * 8 - CHIP_PX))
      return (
        <Box flexDirection="column" paddingTop={1}>
          {shown.map((row, i) => (
            <Box key={`run-${row.id}`} flexDirection="row" alignItems="center" gap={1}>
              <Svg key={`icon-${row.id}`} source={bandIconSvg(row)} alt={row.category} width={28} height={28} />
              <Box key={`body-${row.id}`} flexDirection="column" flexShrink={0}>
                <Svg
                  key={`text-${row.id}`}
                  source={bandTextSvg(W, row, now, i === shown.length - 1 ? more : 0)}
                  alt={`${row.category}: ${row.status}, ${row.description}`}
                  width={W - 32}
                  height={18}
                />
                <Svg key={`track-${row.id}`} source={bandTrackSvg(W, row)} alt={`${row.category} progress`} width={W - 32} height={8} />
              </Box>
              <Box key={`chip-${row.id}`} width={CHIP_COLS} flexShrink={0}>
                {i === 0 && <Button key="run-watcher" label={`⤢ ×${all.length}`} hotkey="r" plain onPress={openPanel} />}
                {i === 1 && showPause ? <Button key="watcher-pause" label="–" hotkey="h" plain onPress={async () => {}} /> : null}
              </Box>
            </Box>
          ))}
          {below && <Box key="run-watcher-gap" height={1} />}
          {below}
        </Box>
      )
    }

    const cols = e.props.bodyColumns || 100
    return (
      <Box flexDirection="column">
        {shown.map((row, i) => (
          <Button key={i === 0 ? 'run-watcher' : `run-${row.id}`} plain onPress={openPanel}>
            <Text color={row.status === 'failed' ? FAILED : categoryOf(row.category).color}>{`${row.status === 'failed' ? '✗' : row.status === 'done' ? '✔' : '›'} ${barText(row, t, 12)} `}</Text>
            <Text bold color={categoryOf(row.category).color}>{labelOf(row, now)}</Text>
            <Text dimColor wrap="truncate-end">{`${cols >= 90 && row.tags.length ? ` [${row.tags.join(', ')}]` : ''} ${statsOf(row, now, cols < 70 ? 1 : 3, true)}${i === shown.length - 1 && more > 0 ? `  +${more}` : ''}`}</Text>
          </Button>
        ))}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const all = ordered(await read($, rows))
    const t = await read($, tick)
    const now = Math.floor((await $.clock.now()) / 1000) * 1000
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg, Link } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      return (
        <Box flexDirection="column">
          <Svg key="pane-header" source={headerSvg(W, all)} alt={`${all.length} background tasks`} width={W} height={44} />
          {all.map(row => (
            <Box key={`pane-${row.id}`} flexDirection="row">
              <Svg key={`picon-${row.id}`} source={paneIconSvg(row)} alt={row.category} width={44} height={44} />
              <Box key={`pbody-${row.id}`} flexDirection="column" flexShrink={0}>
                {row.outputPath ? (
                  <Box key={`plog-${row.id}`} flexDirection="row" justifyContent="flex-end">
                    <Link key={`open-log-${row.id}`} href={`file://${encodeURI(row.outputPath)}`} label="open log ↗" />
                  </Box>
                ) : null}
                <Svg key={`ptext-${row.id}`} source={paneTextSvg(W, row, now)} alt={`${row.category}: ${row.description}`} width={W - 44} height={58} />
                <Svg key={`ptrack-${row.id}`} source={paneTrackSvg(W, row)} alt={`${row.category} progress`} width={W - 44} height={14} />
                <Svg key={`ptail-${row.id}`} source={paneTailSvg(W, row)} alt={row.tail.slice(-1)[0] ?? 'no output yet'} width={W - 44} height={row.tail.slice(-TAIL_LINES).length * 14 + 12} />
              </Box>
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {all.length === 0 && <Text dimColor>No background tasks right now.</Text>}
        {all.map(row => (
          <Box key={`pane-${row.id}`} flexDirection="column">
            <Text bold color={categoryOf(row.category).color}>{`● ${row.category}${row.tags.length ? ` · ${row.tags.join(' · ')}` : ''}`}</Text>
            <Text color={categoryOf(row.category).color}>{barText(row, t, 20)}</Text>
            <Text dimColor>{[row.description, statsOf(row, now, 3)].filter(Boolean).join(' · ')}</Text>
            <Text dimColor wrap="truncate-end">{`$ ${row.command}`}</Text>
            {row.tail.slice(-TAIL_LINES).map((l, i) => (
              <Text key={`tail-${row.id}-${i}`} dimColor wrap="truncate-end">{`  ${l}`}</Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}

// Whether a drawn tree already holds an element with this key (another band's pause button).
function hasKey(node: unknown, key: string): boolean {
  if (!node || typeof node !== 'object') {
    return false
  }
  if (Array.isArray(node)) {
    return node.some(n => hasKey(n, key))
  }
  const el = node as { key?: unknown; props?: { key?: unknown; children?: unknown }; children?: unknown }
  return el.key === key || el.props?.key === key || hasKey(el.props?.children, key) || hasKey(el.children, key)
}
