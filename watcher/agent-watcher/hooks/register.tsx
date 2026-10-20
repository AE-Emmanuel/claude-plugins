import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRow } from '../types'

// How long the band and panel linger after the last agent finishes.
// Set from the plugin's settings when it loads (see plugin.json userConfig).
let LINGER_MS = 10 * 60 * 1000
let BAND_ROWS = 2
const PANE = 'agent-watcher-list'
// The ⤢ chip's column beside the rows.
const CHIP_COLS = 8
const CHIP_PX = CHIP_COLS * 8 + 16

const rows = atom({ plugin: 'agent-watcher', key: 'rows' } as const, [] as AgentRow[])
const tick = atom({ plugin: 'agent-watcher', key: 'tick' } as const, 0)
const isPanelOpen = atom({ plugin: 'agent-watcher', key: 'isPanelOpen' } as const, false)
const isPaused = atom({ plugin: 'agent-watcher', key: 'isPaused' } as const, false)

// Each agent wears its own color (a bandana on the crab, its name, its bar).
// Each agent type gets a stable accent from this palette, picked by its name.
const ACCENTS = ['#3FA7D6', '#E0A526', '#D65DB1', '#8F8CF4', '#3B9C5F', '#E0703A', '#5B8DEF']
const accentOf = (type: string) => {
  let hash = 0
  for (const c of type) hash = (hash * 31 + c.charCodeAt(0)) >>> 0
  return ACCENTS[hash % ACCENTS.length]
}
const DONE = '#3B9C5F'
const FAILED = '#D0453F'
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const shortModel = (model: string) =>
  /opus/i.test(model) ? 'opus' : /sonnet/i.test(model) ? 'sonnet' : /haiku/i.test(model) ? 'haiku' : model

const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

const formatElapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

// Stats read model · time · tools · tokens; a narrow band keeps only the most useful few,
// dropping the model first, then tokens, then tools (elapsed time always stays).
const stats = (row: AgentRow, now: number, keep = 4) => {
  const parts = [
    { rank: 3, text: row.model },
    { rank: 0, text: formatElapsed((row.endedAt ?? now) - row.startedAt) },
    { rank: 1, text: `${row.tools} tools` },
    { rank: 2, text: row.tokens > 0 ? formatTokens(row.tokens) : '' },
  ]
  return parts.filter(p => p.text && p.rank < keep).map(p => p.text).join(' · ')
}

// Running agents first, newest first within each group.
const ordered = (all: AgentRow[]) =>
  [...all].sort((a, b) => {
    const aRunning = a.status === 'running'
    const bRunning = b.status === 'running'
    if (aRunning !== bRunning) {
      return aRunning ? -1 : 1
    }
    return b.startedAt - a.startedAt
  })

const xml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// Rough advance of system UI text, in em; enough to keep text out of the stats.
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

// ---------------------------------------------------------------------------
// Pixel Clawd, adapted from savvy-progress by JohnnyVizz (MIT,
// github.com/JohnnyVizz/claude-kit): a clay crab on a 30×28 grid whose legs step
// while it works. Here every crab wears a bandana in its agent's color.

const CLAY = '#D97757'
const INK = '#1F1E1D'
const CRAB_BOX = 30

const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const crab = (x: number, y: number, accent: string, isWalking: boolean, scale: number) => {
  const px = (cx: number, cy: number, w: number, ht: number, c: string) =>
    `<rect x="${cx}" y="${cy}" width="${w}" height="${ht}" fill="${c}"/>`
  const body = [
    px(7, 10, 16, 12, CLAY),
    px(3, 14, 4, 4, CLAY),
    px(23, 14, 4, 4, CLAY),
    px(9, 13, 2, 2, INK),
    px(19, 13, 2, 2, INK),
    px(6, 9, 18, 3, accent),
    px(3, 10, 3, 2, accent),
  ].join('')
  const legsA = px(7, 22, 2, 4, CLAY) + px(17, 22, 2, 4, CLAY)
  const legsB = px(11, 22, 2, 4, CLAY) + px(21, 22, 2, 4, CLAY)
  return `<g transform="translate(${x},${y}) scale(${scale})" shape-rendering="crispEdges"><g class="${isWalking ? 'run' : ''}"><g class="bd">${body}</g><g class="la">${legsA}</g><g class="lb">${legsB}</g></g></g>`
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
.t{fill:#1f1f1f}.s{fill:#6b6b68}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
.sweep{animation:sw 2s ease-in-out infinite;animation-delay:var(--sweep-delay,0s)}@keyframes sw{0%{transform:translateX(-30%)}100%{transform:translateX(130%)}}
.live{animation:p 1s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
.fill{transform-box:fill-box;transform-origin:left;animation:gr .6s ease-out 1}@keyframes gr{from{transform:scaleX(0)}}
.glow{animation:gw 2.4s ease-in-out infinite}@keyframes gw{50%{opacity:.25}}
.fail{animation:fl .45s ease-in-out 3}@keyframes fl{50%{opacity:.25}}
@media (prefers-reduced-motion: reduce){.sweep,.live,.fill,.fail,.glow{animation:none}}
${TWINKLE_CSS}
</style>`

// A band row is three images: the crab, the text line and the track. Only the text changes as the
// clock ticks; the crab and the track keep the same source while an agent runs, so their animations
// (walking legs, the sweep) are never restarted by redraws, ours or other mods'.
const svg = (W: number, H: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${BASE_CSS}${CRAB_CSS}${body}</svg>`


const track = (id: string, x: number, y: number, w: number, row: AgentRow) => glowTrack(id, x, y, w, accentOf(row.type), row.status)

const mark = (x: number, y: number, row: AgentRow) => {
  if (row.status === 'running') {
    return `<circle class="live" cx="${x}" cy="${y}" r="3" fill="${accentOf(row.type)}"/>`
  }
  if (row.status === 'failed') {
    return `<path d="M${x - 3.5} ${y - 3.5}l7 7M${x + 3.5} ${y - 3.5}l-7 7" stroke="${FAILED}" stroke-width="1.6" stroke-linecap="round"/>`
  }
  return `<path d="M${x - 4.5} ${y}l3 3 6-6.5" fill="none" stroke="${DONE}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
}

// One band row: crab, name, task, stats on the right, a thin track beneath. The row respaces to
// its width: stats drop their least useful parts first, then the task, then the name truncates.
const bandRowSvg = (W: number, row: AgentRow, now: number, more: number) => {
  const extra = more > 0 ? `   +${more}` : ''
  const nameFull = textWidth(row.type, 12.5)
  let keep = 4
  let right = stats(row, now, keep) + extra
  // Keep the name and at least ~90px of task whenever there is room for them.
  while (keep > 1 && W - 34 - nameFull - 8 - textWidth(right, 11.5) - 28 < 90) {
    keep--
    right = stats(row, now, keep) + extra
  }
  const rightW = textWidth(right, 11.5)
  const name = fitText(row.type, 12.5, Math.max(40, W - 34 - rightW - 28))
  const nameW = textWidth(name, 12.5) + 8
  const descW = W - 34 - nameW - rightW - 28
  const desc = row.description && descW >= 48 ? fitText(row.description, 12, descW) : ''
  return svg(
    W - 32,
    18,
    `<text x="0" y="13" font-family="${FONT}" font-size="12.5" font-weight="600" fill="${accentOf(row.type)}">${xml(name)}</text>
<text class="s" x="${nameW}" y="13" font-family="${FONT}" font-size="12">${xml(desc)}</text>
<text class="s" x="${W - 46}" y="13" text-anchor="end" font-family="${FONT}" font-size="11.5" font-variant-numeric="tabular-nums">${xml(right)}</text>
${mark(W - 37, 9, row)}`,
  )
}

const bandTrackSvg = (W: number, row: AgentRow) => svg(W - 32, 8, track(row.id, 0, 2, W - 32, row))
const bandCrabSvg = (row: AgentRow) => svg(28, 28, crab(0, 2, accentOf(row.type), row.status === 'running', 0.8))

const headerSvg = (W: number, all: AgentRow[]) => {
  const running = all.filter(row => row.status === 'running').length
  const tokens = all.reduce((sum, row) => sum + row.tokens, 0)
  const gap = 6
  const tw = (W - gap * 2) / 3
  const tile = (i: number, k: string, v: string) =>
    `<rect class="tile" x="${i * (tw + gap)}" y="0" width="${tw}" height="40" rx="8"/>
<text class="s" x="${i * (tw + gap) + 9}" y="16" font-family="${FONT}" font-size="11">${k}</text>
<text class="t" x="${i * (tw + gap) + 9}" y="33" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  return svg(W, 44, tile(0, 'Running', `${running}`) + tile(1, 'Finished', `${all.length - running}`) + tile(2, 'Tokens', formatTokens(tokens)))
}

// A panel card is three images like a band row: crab and track keep their source while running,
// only the text line ticks, so the panel's animations never restart either.
const paneTextSvg = (W: number, row: AgentRow, now: number) => {
  const textW = W - 44 - 18
  return svg(
    W - 44,
    40,
    `<text class="t" x="0" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(row.description || row.type, 13, textW))}</text>
<text x="0" y="34" font-family="${FONT}" font-size="11"><tspan fill="${accentOf(row.type)}">${xml(row.type)}</tspan><tspan class="s">  ${xml(stats(row, now))}</tspan></text>
${mark(W - 52, 14, row)}`,
  )
}
const paneTrackSvg = (W: number, row: AgentRow) =>
  svg(W - 44, 22, `${halo(`p${row.id}`, 0, 5, W - 44 - 8, accentOf(row.type), row.status, null)}${track(`p${row.id}`, 0, 5, W - 44 - 8, row)}<line class="ln" x1="0" y1="21.5" x2="${W - 44}" y2="21.5"/>`)
const paneCrabSvg = (row: AgentRow) => svg(44, 62, crab(0, 12, accentOf(row.type), row.status === 'running', 1.1))

// Terminal fallback: a colored dot, a block bar and plain text.
const barText = (row: AgentRow, t: number, width: number) => {
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

export const register: Register = (on, options) => {
  LINGER_MS = Math.max(1, Number(options.lingerMinutes ?? 10)) * 60 * 1000
  BAND_ROWS = Math.max(1, Math.min(4, Number(options.bandRows ?? 2)))
  let pulse: { cancel: () => void } | null = null
  let clear: { cancel: () => void } | null = null

  // A reload keeps the rows but drops the timers: restart the pulse or the hide timer.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      const all = await read($, rows)
      if (all.some(row => row.status === 'running')) {
        pulse = $.clock.every(1000, () => {
          void update($, tick, t => t + 1).catch(() => {})
        })
      } else if (all.length > 0) {
        clear = $.clock.after(LINGER_MS, () => {
          clear = null
          void update($, rows, list => list.filter(row => row.status === 'running')).catch(() => {})
          void update($, isPanelOpen, () => false).catch(() => {})
          void $.ui.close({ id: PANE }).catch(() => {})
        })
      }
    } catch {}
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (!result.agentId) {
      return result
    }

    // The band is cosmetic: a failure here must never affect the spawn.
    try {
      clear?.cancel()
      clear = null
      const row: AgentRow = {
        id: result.agentId,
        type: e.subagentType || 'general-purpose',
        description: e.description ?? '',
        model: shortModel(result.model ?? ''),
        startedAt: await $.clock.now(),
        endedAt: null,
        tools: 0,
        tokens: 0,
        status: 'running',
      }
      await update($, rows, all => [...all, row])

      // The crabs and sweeps animate in CSS; this tick only refreshes the elapsed time.
      if (!pulse) {
        pulse = $.clock.every(1000, () => {
          void update($, tick, t => t + 1).catch(() => {})
        })
      }
    } catch {}
    return result
  }).catch(($, e, next) => next(e)) // display only: a failure never blocks Claude Code

  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      // Display bookkeeping must never hold up or fail the tool call.
      void update($, rows, all => all.map(row => (row.id === id ? { ...row, tools: row.tools + 1 } : row))).catch(() => {})
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // display only: a failure never blocks Claude Code

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      return result
    }

    try {
      const usage = result.usage ?? e.usage
      const spent = usage
        ? usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
        : 0
      const now = await $.clock.now()
      const id = e.agentId
      // Anything but a normal answer (an error, an abort, a refusal) ends the sweep as a failure.
      const status: AgentRow['status'] = e.reason !== 'answer' || e.isAborted ? 'failed' : 'done'
      await update($, rows, all =>
        all.map(row => (row.id === id ? { ...row, tokens: row.tokens + spent, status, endedAt: now } : row)),
      )

      const isAnyRunning = (await read($, rows)).some(row => row.status === 'running')
      if (!isAnyRunning) {
        pulse?.cancel()
        pulse = null
        clear?.cancel()
        clear = $.clock.after(LINGER_MS, () => {
          clear = null
          void update($, rows, all => all.filter(row => row.status === 'running')).catch(() => {})
          void update($, isPanelOpen, () => false).catch(() => {})
          void $.ui.close({ id: PANE }).catch(() => {})
        })
      }
    } catch {}
    return result
  })

  // The pause key (h, in any Watcher band) hides every band until the person's next prompt.
  on('ui.press', { element: 'watcher-pause' }, async ($, e, next) => {
    await update($, isPaused, () => true).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind !== 'task-notification') {
      await update($, isPaused, () => false).catch(() => {})
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The band steps aside while the panel is open and comes back when it closes.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await update($, isPanelOpen, () => false).catch(() => {})
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // display only: a failure never blocks Claude Code

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const all = await read($, rows)
    if (e.props.hasSurvey || all.length === 0 || (await read($, isPanelOpen)) || (await read($, isPaused))) {
      return next(e)
    }
    // Other bands (context-watcher) draw beneath these rows; the engine's own placeholder is never nested.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const t = await read($, tick)
    // Whole seconds: within a second the images come out identical, so other mods' redraws don't rebuild them.
    const now = Math.floor((await $.clock.now()) / 1000) * 1000
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const shown = ordered(all).slice(0, BAND_ROWS)
    const more = all.length - shown.length
    const openPanel = async () => {
      await update($, isPanelOpen, () => true)
      await $.ui.open({ id: PANE, title: 'Agents' })
    }

    // The terminal's element table carries an Svg that draws nothing: test the surface too.
    // The pause key shows only when another Watcher band is up too, once, in this band's second
    // row's free chip slot, so it never crowds the open button.
    const showPause = below !== null && !hasKey(below, 'watcher-pause')

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      // Desktop cells are ~8px. Every row reserves the chip's column, so the rows' right edges line up.
      const W = Math.max(200, Math.min(1400, (e.props.bodyColumns || 100) * 8 - CHIP_PX))
      return (
        <Box flexDirection="column" paddingTop={1}>
          {shown.map((row, i) => (
            <Box key={`band-${row.id}`} flexDirection="row" alignItems="center" gap={1}>
              <Svg key={`crab-${row.id}`} source={bandCrabSvg(row)} alt={row.type} width={28} height={28} />
              <Box key={`body-${row.id}`} flexDirection="column" flexShrink={0}>
                <Svg
                  key={`text-${row.id}`}
                  source={bandRowSvg(W, row, now, i === shown.length - 1 ? more : 0)}
                  alt={`${row.type}: ${row.status}, ${stats(row, now)}`}
                  width={W - 32}
                  height={18}
                />
                <Svg key={`track-${row.id}`} source={bandTrackSvg(W, row)} alt={`${row.type} progress`} width={W - 32} height={8} />
              </Box>
              <Box key={`chip-${row.id}`} width={CHIP_COLS} flexShrink={0}>
                {i === 0 && <Button key="agent-watcher" label={`⤢ ×${all.length}`} hotkey="a" plain onPress={openPanel} />}
                {i === 1 && showPause ? <Button key="watcher-pause" label="–" hotkey="h" plain onPress={() => {}} /> : null}
              </Box>
            </Box>
          ))}
          {below && <Box key="agent-watcher-gap" height={1} />}
          {below}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {shown.map((row, i) => (
          <Button key={i === 0 ? 'agent-watcher' : `band-${row.id}`} plain onPress={openPanel}>
            <Text color={accentOf(row.type)}>{`${row.status === 'failed' ? '✗' : '●'} ${barText(row, t, 12)} `}</Text>
            <Text bold color={accentOf(row.type)}>
              {row.type}
            </Text>
            <Text dimColor wrap="truncate-end">{` ${stats(row, now, (e.props.bodyColumns || 100) < 70 ? 1 : (e.props.bodyColumns || 100) < 90 ? 3 : 4)}${i === shown.length - 1 && more > 0 ? `  +${more}` : ''}`}</Text>
          </Button>
        ))}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const all = ordered(await read($, rows))
    const t = await read($, tick)
    // Whole seconds: within a second the images come out identical, so other mods' redraws don't rebuild them.
    const now = Math.floor((await $.clock.now()) / 1000) * 1000
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      return (
        <Box flexDirection="column">
          <Svg key="pane-header" source={headerSvg(W, all)} alt={`${all.length} agents`} width={W} height={44} />
          {all.map(row => (
            <Box key={`pane-${row.id}`} flexDirection="row">
              <Svg key={`pcrab-${row.id}`} source={paneCrabSvg(row)} alt={row.type} width={44} height={62} />
              <Box key={`pbody-${row.id}`} flexDirection="column" flexShrink={0}>
                <Svg key={`ptext-${row.id}`} source={paneTextSvg(W, row, now)} alt={`${row.type}: ${row.status}, ${stats(row, now)}`} width={W - 44} height={40} />
                <Svg key={`ptrack-${row.id}`} source={paneTrackSvg(W, row)} alt={`${row.type} progress`} width={W - 44} height={22} />
              </Box>
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {all.length === 0 && <Text dimColor>No agents right now.</Text>}
        {all.map(row => (
          <Box key={`pane-${row.id}`} flexDirection="column">
            <Text bold color={accentOf(row.type)}>{`● ${row.type}`}</Text>
            <Text color={accentOf(row.type)}>{barText(row, t, 20)}</Text>
            <Text dimColor>{[row.description, stats(row, now)].filter(Boolean).join(' · ')}</Text>
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
