import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Meter, Shown } from '../types'

// How long the band lingers after a prompt's turn ends.
// Set from the plugin's settings when it loads (see plugin.json userConfig).
let LINGER_MS = 10 * 60 * 1000
let SHOW_PACE = true
// A changed figure glides to its new value: one step per frame, a quarter of the gap each time.
const GLIDE_MS = 40
const CAROUSEL_MS = 2500
const CLAY = '#D97757'
const CONTEXT = '#5B8DEF'
const WARN = '#E0A526'
const HOT = '#D0453F'
// Each family keeps its own tint in the carousel.
const FAMILY_TINT: Record<string, string> = { Opus: '#D97757', Sonnet: '#5B8DEF', Haiku: '#3B9C5F', Fable: '#8F8CF4' }

const meter = atom({ plugin: 'context-watcher', key: 'meter' } as const, {
  model: '',
  agentModels: {},
  contextTokens: null,
  contextWindow: 0,
  contextPercent: null,
  usagePercent: null,
  usageResetsAt: null,
  isActive: false,
  isVisible: false,
} as Meter)
const tick = atom({ plugin: 'context-watcher', key: 'tick' } as const, 0)
const isPaused = atom({ plugin: 'context-watcher', key: 'isPaused' } as const, false)
// What the bars show right now, easing toward the meter's figures.
const shown = atom({ plugin: 'context-watcher', key: 'shown' } as const, { context: 0, usage: 0, carousel: 0, carouselAt: 0, breath: 0, contextGlowAt: 0, usageGlowAt: 0 } as Shown)

// A bar that grows starts bright and fades back to its color over this long.
const GLOW_MS = 1000

// Mix a hex color toward white by t (0 = the color, 1 = white).
const brighten = (hex: string, t: number) => {
  const n = parseInt(hex.slice(1), 16)
  const ch = (shift: number) => {
    const c = (n >> shift) & 255
    return Math.round(c + (255 - c) * t).toString(16).padStart(2, '0')
  }
  return '#' + ch(16) + ch(8) + ch(0)
}

const glowColor = (base: string, glowAt: number, now: number) => {
  const age = now - glowAt
  return age >= 0 && age < GLOW_MS ? brighten(base, 0.6 * (1 - age / GLOW_MS)) : base
}

// When context grows, the big bar shimmers once: an ultracode-style band of shifting colors
// runs across the fill and fades out. Native text, so nothing flickers; the glide timer drives it.
const SHIMMER_MS = 1600
const ULTRA = ['#D97757', '#E0A526', '#D65DB1', '#8F8CF4', '#5B8DEF']
const HEAD = 6 // half-width of the shimmering band, in cells

// The bar's design: blue blocks, then the dotted ░ rest; the figures above end where it ends.
// Measured on desktop, in layout cells (with a little margin): a █ draws about 1.62 wide, a ░
// about 1.26, a ━ or ─ about 1.55.
const BLOCK_W = 1.53
const DOT_W = 1.17 // measured from screenshots at 9% and 47%
const LINE_W = 1.6

// The filled cells as runs of one color each: the base color, or the shimmer near its head.
// `isReverse`: the band runs right to left (context compacted) instead of left to right (it grew).
const shimmerRuns = (fill: number, base: string, age: number, isReverse = false) => {
  const runs: { color: string; text: string }[] = []
  const isOn = age >= 0 && age < SHIMMER_MS
  const travel = (age / SHIMMER_MS) * (fill + HEAD * 4)
  const head = isReverse ? fill + HEAD * 2 - travel : travel - HEAD * 2
  const fade = 1 - age / SHIMMER_MS
  for (let i = 0; i < fill; i++) {
    let color = base
    const d = Math.abs(i - head)
    if (isOn && d < HEAD) {
      const hue = ULTRA[Math.floor((i + age / 120) / 2) % ULTRA.length] ?? base
      // Quantized so neighbouring cells share a color and the row stays a few runs.
      color = brighten(hue, Math.round((1 - d / HEAD) * fade * 3) / 6)
    }
    const last = runs[runs.length - 1]
    if (last && last.color === color) {
      last.text += '█'
    } else {
      runs.push({ color, text: '█' })
    }
  }
  return runs
}

// While the main model works its name breathes in its family color; idle, it rests in plain white.
const BREATHE_MS = 300
const BREATHE_STEPS = 8
const breathe = (tint: string, frame: number) => {
  const phase = (frame % BREATHE_STEPS) / BREATHE_STEPS
  return brighten(tint, 0.35 * (0.5 + 0.5 * Math.cos(phase * 2 * Math.PI)))
}

// A new name in the carousel rises out of grey over FADE_MS (the breathing timer paints the frames).
const FADE_MS = 900
const fadeIn = (hex: string, age: number) => {
  if (age < 0 || age >= FADE_MS) {
    return hex
  }
  const t = 1 - age / FADE_MS
  const n = parseInt(hex.slice(1), 16)
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * (1 - t) + 0x55 * t).toString(16).padStart(2, '0')
  return '#' + ch(16) + ch(8) + ch(0)
}

const step = (from: number, to: number) => (Math.abs(to - from) < 0.3 ? to : from + (to - from) * 0.25)

// A thin savvy-style track in text: heavy line for the fill, light line for the rest.
const track = (percent: number, width: number) => {
  const exact = (width * Math.max(0, Math.min(100, percent))) / 100
  const full = Math.round(exact)
  return { fill: '━'.repeat(full), rest: '─'.repeat(width - full) }
}

// "claude-opus-5-5" → "Opus 5.5"; anything unrecognised shows as it came.
const modelName = (id: string) => {
  const m = /(opus|sonnet|haiku|fable)[-_ ]?(\d+)(?:[-_.](\d+))?/i.exec(id)
  if (!m || !m[1] || !m[2]) {
    return id.replace(/^claude-/, '') || 'Claude'
  }
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

const effortText = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? `${v}` : '')

const tintOf = (name: string) => FAMILY_TINT[name.split(' ')[0] ?? ''] ?? CLAY

// The main model first, then each other model a running agent uses, once each.
const modelsInUse = (m: Meter) => [...new Set([m.model, ...Object.values(m.agentModels)].filter(Boolean).map(modelName))]

const formatCount = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

const resetsIn = (iso: string | null, now: number) => {
  if (!iso) {
    return ''
  }
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms) || ms <= 0) {
    return ''
  }
  const m = Math.round(ms / 60000)
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

// Usage pace: how fast this 5-hour window is being spent since its first reading. Quiet until
// there is enough to go on (10 minutes and 2 points), then the time to 100% at this rate.
const PACE_MIN_MS = 10 * 60 * 1000
const pace = (m: Meter, now: number) => {
  const from = m.paceFrom
  const pctNow = m.usagePercent
  if (!from || pctNow === null || pctNow >= 100 || now - from.at < PACE_MIN_MS || pctNow - from.percent < 2) {
    return null
  }
  const msPerPoint = (now - from.at) / (pctNow - from.percent)
  const toFull = (100 - pctNow) * msPerPoint
  const resetMs = m.usageResetsAt ? Date.parse(m.usageResetsAt) - now : Infinity
  const isShort = Number.isFinite(resetMs) && toFull < resetMs
  const m2 = Math.round(toFull / 60000)
  const label = m2 >= 60 ? `${Math.floor(m2 / 60)}h ${String(m2 % 60).padStart(2, '0')}m` : `${m2}m`
  return isShort ? { text: `full in ~${label}`, isShort } : { text: 'on pace', isShort }
}

// Calm until it matters: the base color, amber past 70%, red past 90%.
const levelColor = (percent: number, base: string) => (percent >= 90 ? HOT : percent >= 70 ? WARN : base)


export const register: Register = (on, options) => {
  LINGER_MS = Math.max(1, Number(options.lingerMinutes ?? 10)) * 60 * 1000
  SHOW_PACE = options.showUsagePace !== false
  let hide: { cancel: () => void } | null = null
  let pulse: { cancel: () => void } | null = null
  let glide: { cancel: () => void } | null = null
  let spin: { cancel: () => void } | null = null
  let breathing: { cancel: () => void } | null = null

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // A reload keeps the meter but drops timers: let a shown band still hide on time.
    try {
      const m = await read($, meter)
      if (m.isVisible && !m.isActive) {
        hide = $.clock.after(LINGER_MS, () => {
          hide = null
          void update($, meter, cur => ({ ...cur, isVisible: false })).catch(() => {})
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

  // A prompt from the user is the only thing that brings the band up.
  on('prompt.submit', async ($, e, next) => {
    try {
      if (e.origin?.kind !== 'task-notification') {
        await update($, isPaused, () => false)
      }
      hide?.cancel()
      hide = null
      const model = await $.session.model().catch(() => '')
      const usage = await $.session.usage().catch(() => null)
      const submittedAt = await $.clock.now()
      // Entry: when the card comes up after being hidden, its bars start empty and grow to the
      // figures while the colorful shimmer runs across them once.
      if (!(await read($, meter)).isVisible) {
        await update($, shown, v => ({ ...v, context: 0, usage: 0, contextGlowAt: submittedAt, usageGlowAt: submittedAt }))
      }
      await update($, meter, m => ({
        ...m,
        model: model || m.model,
        contextTokens: usage?.context.tokens ?? m.contextTokens,
        contextWindow: usage?.context.window ?? m.contextWindow,
        contextPercent: usage?.context.percent ?? m.contextPercent,
        ...usageOf(usage?.rateLimits ?? [], m, submittedAt),
        isActive: true,
        isVisible: true,
      }))
      // Refresh the reset countdown once a minute while shown.
      if (!pulse) {
        pulse = $.clock.every(60_000, () => {
          void update($, tick, t => t + 1).catch(() => {})
        })
      }
      // The name breathes while the model works (slow on purpose: every redraw rebuilds the whole band).
      if (!breathing) {
        breathing = $.clock.every(BREATHE_MS, () => {
          void update($, shown, v => ({ ...v, breath: v.breath + 1 })).catch(() => {})
        })
      }
      // Several models in use take turns in the name slot.
      if (!spin) {
        spin = $.clock.every(CAROUSEL_MS, () => {
          void (async () => {
            if (modelsInUse(await read($, meter)).length > 1) {
              const at = await $.clock.now()
              await update($, shown, v => ({ ...v, carousel: v.carousel + 1, carouselAt: at }))
            }
          })().catch(() => {})
        })
      }
      // Glide the bars to the new figures and keep the carousel turning while shown.
      if (!glide) {
        glide = $.clock.every(GLIDE_MS, () => {
          void (async () => {
            const m = await read($, meter)
            const cur = await read($, shown)
            const context = step(cur.context, m.contextPercent ?? 0)
            const usage = step(cur.usage, m.usagePercent ?? 0)
            const now = await $.clock.now()
            const isGlowing = now - cur.contextGlowAt < SHIMMER_MS || now - cur.usageGlowAt < GLOW_MS
            if (context === cur.context && usage === cur.usage && !isGlowing) {
              glide?.cancel()
              glide = null
              return
            }
            await update($, shown, v => ({ ...v, context, usage }))
          })().catch(() => {})
        })
      }
    } catch {}
    return next(e)
  }).catch(($, e, next) => next(e)) // display only: a failure never blocks Claude Code

  // Context and usage move: take the new figures, and mark a rise so it animates.
  on('session.measure', async ($, e, next) => {
    try {
      const before = await read($, meter)
      const after = { ...before, ...usageOf(e.rateLimits, before, await $.clock.now()) }
      const contextTokens = e.context.tokens ?? before.contextTokens
      // Nothing visible moved (same whole percent and same thousand tokens): skip the redraw.
      const isSame =
        Math.round(e.context.percent ?? -1) === Math.round(before.contextPercent ?? -1) &&
        Math.round((contextTokens ?? 0) / 1000) === Math.round((before.contextTokens ?? 0) / 1000) &&
        after.usagePercent === before.usagePercent
      if (isSame) {
        return next(e)
      }
      const glowNow = await $.clock.now()
      const isContextUp = (e.context.percent ?? 0) > (before.contextPercent ?? 0)
      // A sharp drop is a compaction: the shimmer runs back, right to left, as the bar shrinks.
      const isCompacted = (before.contextPercent ?? 0) - (e.context.percent ?? 0) >= 5
      const isUsageUp = (after.usagePercent ?? 0) > (before.usagePercent ?? 0)
      if (isContextUp || isUsageUp || isCompacted) {
        await update($, shown, v => ({
          ...v,
          contextGlowAt: isContextUp || isCompacted ? glowNow : v.contextGlowAt,
          compactAt: isCompacted ? glowNow : v.compactAt,
          usageGlowAt: isUsageUp ? glowNow : v.usageGlowAt,
        }))
      }
      await update($, meter, m => ({
        ...m,
        contextTokens,
        contextWindow: e.context.window || m.contextWindow,
        contextPercent: e.context.percent ?? m.contextPercent,
        usagePercent: after.usagePercent,
        usageResetsAt: after.usageResetsAt,
        paceFrom: after.paceFrom,
      }))
      // Glide the bars to the new figures and keep the carousel turning while shown.
      if (!glide) {
        glide = $.clock.every(GLIDE_MS, () => {
          void (async () => {
            const m = await read($, meter)
            const cur = await read($, shown)
            const context = step(cur.context, m.contextPercent ?? 0)
            const usage = step(cur.usage, m.usagePercent ?? 0)
            const now = await $.clock.now()
            const isGlowing = now - cur.contextGlowAt < SHIMMER_MS || now - cur.usageGlowAt < GLOW_MS
            if (context === cur.context && usage === cur.usage && !isGlowing) {
              glide?.cancel()
              glide = null
              return
            }
            await update($, shown, v => ({ ...v, context, usage }))
          })().catch(() => {})
        })
      }
    } catch {}
    return next(e)
  })

  // Agents join the carousel with their model while they run.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      const id = result.agentId
      const model = result.model
      if (id && model) {
        await update($, meter, m => ({ ...m, agentModels: { ...m.agentModels, [id]: model } }))
      }
    } catch {}
    return result
  }).catch(($, e, next) => next(e)) // display only: a failure never blocks Claude Code

  // Each model request: note the effort it asks for (the main loop's, or an agent's by id).
  on('turn.step', async function* ($, e, next) {
    // Streams: forward every chunk untouched, then note the step once it is answered.
    const result = yield* next(e)
    try {
      const effort = effortText(e.effort)
      const id = e.agentId
      if (id) {
        await update($, meter, m => ({ ...m, agentEfforts: { ...(m.agentEfforts ?? {}), [id]: effort } }))
      } else if (effort) {
        await update($, meter, m => ({ ...m, effort }))
      }
    } catch {}
    return result
  }).catch(async function* ($, e, next) {
    // display only: a failure never blocks Claude Code
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.agentId) {
        const id = e.agentId
        await update($, meter, m => {
          const rest = { ...m.agentModels }
          const efforts = { ...(m.agentEfforts ?? {}) }
          delete efforts[id]
          delete rest[id]
          return { ...m, agentModels: rest, agentEfforts: efforts }
        })
        return result
      }
      // The main turn is done and the figures are final: settle, then hide after the linger.
      const model = result.usage?.model ?? e.usage?.model
      breathing?.cancel()
      breathing = null
      await update($, meter, m => ({ ...m, model: model || m.model, isActive: false }))
      hide?.cancel()
      hide = $.clock.after(LINGER_MS, () => {
        hide = null
        pulse?.cancel()
        pulse = null
        spin?.cancel()
        spin = null
        void update($, meter, m => ({ ...m, isVisible: false })).catch(() => {})
      })
    } catch {}
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const m = await read($, meter)
    if (!m.isVisible || e.props.hasSurvey || (await read($, isPaused))) {
      return next(e)
    }
    // Other bands (agent-watcher) draw beneath this row; the engine's own placeholder is never nested.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    await read($, tick)
    const now = await $.clock.now()
    const s = await read($, shown)
    const { Box, Button, Text } = $.ui.resolve(e)
    const names = modelsInUse(m)
    const name = names.length ? (names[s.carousel % names.length] ?? 'Claude') : 'Claude'
    const reset = resetsIn(m.usageResetsAt, now)
    // The effort of whichever loop runs the model shown: the main loop's, or an agent's on it.
    const agentOnName = Object.keys(m.agentModels).find(id => modelName(m.agentModels[id] ?? '') === name && id in (m.agentEfforts ?? {}))
    const nameEffort = name === modelName(m.model) ? (m.effort ?? '') : agentOnName ? (m.agentEfforts?.[agentOnName] ?? '') : ''
    const ctxDetail = m.contextTokens !== null && m.contextWindow ? `${formatCount(m.contextTokens)} / ${formatCount(m.contextWindow)}` : ''
    // Native text, not an image: it updates in place, so nothing flashes when a figure moves.
    // A card as wide as the prompt: the model and the context figures on top, the big context
    // bar across the whole width, then usage on its own thin line underneath.
    const cols = e.props.bodyColumns || 100
    const inner = Math.max(10, cols - 4) // the border and padding take 4 cells
    const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v)}%`)
    const usePace = SHOW_PACE && m.usagePercent !== null ? pace(m, now) : null
    // The usage track takes the room its line has left (label, %, reset time and pace need ~40 cells).
    const useW = Math.max(6, Math.floor((inner - 40) / (e.surface === "terminal" ? 1 : LINE_W)))
    const use = track(s.usage, useW)
    // The pause key shows only when another Watcher band is up too (alone, the card needs none),
    // and only once: the first band that finds none beneath it draws it.
    const showPause = below !== null && !hasKey(below, 'watcher-pause')

    // The big bar: blue blocks, then the dotted ░ rest, running to one cell short of the card's edge;
    // the figures above (tokens · percentage) end at the same place. Desktop draws █ and ░ at different widths (both
    // wider than a layout cell), so fill and rest are counted separately from those widths and the
    // bar keeps one length at any percentage.
    const base = levelColor(s.context, CONTEXT)
    const age = now - (s.contextGlowAt ?? 0)
    const share = Math.max(0, Math.min(100, s.context)) / 100
    const span = Math.max(8, inner)
    const isTerminal = e.surface === 'terminal'
    const blockW = isTerminal ? 1 : BLOCK_W
    const dotW = isTerminal ? 1 : DOT_W
    const fill = Math.round((span * share) / blockW)
    const restDots = Math.max(0, Math.floor((span - fill * blockW) / dotW))
    const runs = shimmerRuns(fill, base, age, s.compactAt !== undefined && s.compactAt === s.contextGlowAt)
    const bar = (
      <Box key="bar" flexDirection="row" flexShrink={0}>
        <Text>
          {runs.map((r, i) => (
            <Text key={`run-${i}`} color={r.color}>{r.text}</Text>
          ))}
          <Text dimColor>{'░'.repeat(restDots)}</Text>
        </Text>
      </Box>
    )

    // Layout: three rows that never change height. Left groups hold labels and figures, right
    // groups hold details; only small changing numbers get a fixed width.
    return (
      <Box flexDirection="column">
        {below}
        <Box key="context-watcher" flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
          <Box key="head" flexDirection="row" justifyContent="space-between">
            <Box key="title" flexDirection="row" gap={1} flexShrink={0}>
              <Text dimColor>{'Context ·'}</Text>
              <Text bold color={m.isActive ? fadeIn(breathe(tintOf(name), s.breath), now - (s.carouselAt ?? 0)) : undefined}>{name}</Text>
              {nameEffort ? <Text dimColor>{nameEffort}</Text> : null}
            </Box>
            {/* Ends where the dotted bar below ends, one cell in from the card's edge. */}
            <Box key="figures" flexDirection="row" flexShrink={1} marginRight={1}>
              <Text dimColor wrap="truncate-end">{ctxDetail ? `${ctxDetail} · ` : ''}</Text>
              <Text bold>{pct(m.contextPercent)}</Text>
            </Box>
          </Box>
          {bar}
          <Box key="usage" flexDirection="row" gap={1}>
            <Text dimColor>{'Usage'}</Text>
            {m.usagePercent === null ? null : (
              <Box key="use-track" flexShrink={1}>
                <Text wrap="truncate-end" color={glowColor(levelColor(s.usage, CLAY), s.usageGlowAt, now)}>{use.fill}</Text>
                <Text dimColor>{use.rest}</Text>
              </Box>
            )}
            <Box key="use-pct" width={4} flexShrink={0} justifyContent="flex-end">
              <Text bold={m.usagePercent !== null} dimColor={m.usagePercent === null}>{pct(m.usagePercent)}</Text>
            </Box>
            <Box key="use-detail" flexShrink={1}>
              <Text dimColor wrap="truncate-end">{reset ? `resets in ${reset}` : ''}</Text>
            </Box>
            {usePace ? (
              <Box key="use-pace" flexShrink={0}>
                <Text color={usePace.isShort ? WARN : undefined} dimColor={!usePace.isShort}>{`· ${usePace.text}`}</Text>
              </Box>
            ) : null}
            {showPause ? (
              <Box key="use-pause" flexGrow={1} justifyContent="flex-end">
                <Button key="watcher-pause" label="–" hotkey="h" plain onPress={() => {}} />
              </Box>
            ) : null}
          </Box>
        </Box>
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

// Usage here is the 5-hour window; the weekly one is left out on purpose.
function usageOf(limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[], m: Meter, now: number) {
  const five = limits.find(l => l.kind === 'five_hour')
  if (!five) {
    return { usagePercent: m.usagePercent, usageResetsAt: m.usageResetsAt, paceFrom: m.paceFrom }
  }
  const resetsAt = five.resetsAt ?? m.usageResetsAt
  // A new window (another reset time, or usage fell) starts measuring the pace again.
  const isNewWindow = !m.paceFrom || m.paceFrom.resetsAt !== resetsAt || five.percentUsed < m.paceFrom.percent
  return {
    usagePercent: five.percentUsed,
    usageResetsAt: resetsAt,
    paceFrom: isNewWindow ? { at: now, percent: five.percentUsed, resetsAt } : m.paceFrom,
  }
}
