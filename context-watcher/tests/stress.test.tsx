import { expect, mock, test } from 'claude-code/testing'

const at = (cols: number) => ({ component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: cols } }) as const

test('fits any width, survives missing figures and old saved state, and its timers stop', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  on('session.model', () => ({ value: '' }) as any)
  // No usage figures at all (e.g. an API-key session without rate limits).
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: null, window: 0, percent: null }, rateLimits: [] } }) as any)
  on('prompt.submit', () => ({ text: 'hi' }) as any)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  await $.prompt.submit({ text: 'hi' } as any)
  for (const cols of [12, 40, 100, 300]) {
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'context-watcher', surface, ...at(cols) })
      expect(await ui.find({ type: 'Text', text: /Claude/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /NaN|undefined/ })).toBeUndefined()
      await ui.unmount()
    }
  }

  // Over 100% (past the window) and a big jump: no overflow, no bad colors.
  await $.session.measure({ context: { tokens: 1_200_000, window: 1_000_000, percent: 120 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100 }], changed: ['context', 'rateLimits'] } as any)
  await clock.advance(700)
  const ui = await $.ui.mount({ plugin: 'context-watcher', surface: 'desktop', ...at(100) })
  const colors = ((await ui.findAll({ type: 'Text' })) as any[]).map(t => t.props.color).filter(Boolean)
  expect(colors.every((c: string) => /^#[0-9a-f]{6}$/i.test(c) || !c.startsWith('#'))).toBe(true)
  await ui.unmount()

  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(11 * 60 * 1000)
  const gone = await $.ui.mount({ plugin: 'context-watcher', surface: 'terminal', ...at(100) })
  expect(await gone.find({ type: 'Text', text: /Context/ })).toBeUndefined()
  await gone.unmount()
})

test('usage pace: quiet at first, then warns when 100% comes before the reset', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  const limits = (p: number) => [{ kind: 'five_hour', percentUsed: p, resetsAt: '2026-10-14T14:00:00Z' }]
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as any)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: limits(20) } }) as any)
  on('prompt.submit', () => ({ text: 'hi' }) as any)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const find = async (text: RegExp) => {
    const ui = await $.ui.mount({ plugin: 'context-watcher', surface: 'terminal', ...at(140) })
    const found = await ui.find({ type: 'Text', text })
    await ui.unmount()
    return found
  }
  await $.prompt.submit({ text: 'hi' } as any)
  expect(await find(/full in|on pace/)).toBeUndefined()
  // 20% → 50% in 30 minutes: 100% in ~50m, well before the reset at 14:00.
  await clock.advance(30 * 60 * 1000)
  await $.session.measure({ context: { tokens: 2000, window: 200_000, percent: 1 }, rateLimits: limits(50), changed: ['rateLimits'] } as any)
  expect(await find(/full in ~50m/)).toBeDefined()
})

test('entry: the card comes up with the bar growing in under the shimmer', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as any)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 300_000, window: 1_000_000, percent: 30 }, rateLimits: [] } }) as any)
  on('prompt.submit', () => ({ text: 'hi' }) as any)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const colors = async () => {
    const ui = await $.ui.mount({ plugin: 'context-watcher', surface: 'terminal', ...at(100) })
    const list = ((await ui.findAll({ type: 'Text', text: /█/ })) as any[]).filter(t => t.props.color)
    await ui.unmount()
    return list
  }
  await $.prompt.submit({ text: 'hi' } as any)
  await clock.advance(500)
  const mid = await colors()
  expect(mid.some(t => t.props.color !== '#5B8DEF')).toBe(true)
  await clock.advance(2000)
  const end = await colors()
  expect(end.map(t => t.props.color)).toEqual(['#5B8DEF'])
  expect(end[0].text.length).toBe(Math.round((100 - 4 - 1) * 0.3))
})

test('bar: fixed length, figures right after it, always leaves room for them', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as any)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 390_000, window: 1_000_000, percent: 39 }, rateLimits: [] } }) as any)
  on('prompt.submit', () => ({ text: 'hi' }) as any)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.prompt.submit({ text: 'hi' } as any)
  for (const pctNow of [39, 99.6, 120]) {
    await $.session.measure({ context: { tokens: 390_000, window: 1_000_000, percent: pctNow }, rateLimits: [], changed: ['context'] } as any)
    await clock.advance(3000)
    for (const cols of [30, 100, 300]) {
      for (const surface of ['terminal', 'desktop'] as const) {
        const ui = await $.ui.mount({ plugin: 'context-watcher', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: cols } } as any)
        const glyphs = ((await ui.findAll({ type: 'Text', text: /^[█░]+$/ })) as any[]).filter(t => t.props.color || t.props.dimColor).reduce((n, t) => n + String(t.text).length, 0)
        // The bar never takes the percentage's room or the padding.
        expect(glyphs > 0 && glyphs <= Math.max(8, cols - 4)).toBe(true)
        expect(await ui.find({ type: 'Text', text: /^\d+%$/ })).toBeDefined()
        await ui.unmount()
      }
    }
  }
})
