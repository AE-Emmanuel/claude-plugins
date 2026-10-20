import { expect, mock, test } from 'claude-code/testing'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } } as const

test('title reads Context · model, the fill in its plain color', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as any)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 300_000, window: 1_000_000, percent: 30 }, rateLimits: [] } }) as any)
  on('prompt.submit', () => ({ text: 'hi' }) as any)
  on('turn.complete', () => ({ text: 'ok' }) as any)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const fillColors = async () => {
    const ui = await $.ui.mount({ plugin: 'context-watcher', surface: 'terminal', ...BAND })
    const colors = ((await ui.findAll({ type: 'Text', text: /^█+$/ })) as any[]).map(t => t.props.color).filter(Boolean)
    await ui.unmount()
    return colors
  }
  const find = async (re: RegExp) => {
    const ui = await $.ui.mount({ plugin: 'context-watcher', surface: 'terminal', ...BAND })
    const found = await ui.find({ type: 'Text', text: re })
    await ui.unmount()
    return found
  }

  await $.prompt.submit({ text: 'hi' } as any)
  await clock.advance(3000)
  // Before any response the cache is cold: the fill rests in its color.
  expect(await fillColors()).toEqual(['#5B8DEF'])

  // Title order: Context · model (effort appears once a model request reports it; the test kit
  // cannot raise the streaming turn.step event, so the effort label is checked on screen).
  expect(await find(/^Context ·$/)).toBeDefined()
  expect(await find(/^Opus 5\.5$/)).toBeDefined()
})

test('compaction: the shimmer runs right to left as the bar shrinks', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as any)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 600_000, window: 1_000_000, percent: 60 }, rateLimits: [] } }) as any)
  on('prompt.submit', () => ({ text: 'hi' }) as any)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  // Where along the fill the shimmer's colored cells start (0 = left end, 1 = right end).
  const shimmerAt = async () => {
    const ui = await $.ui.mount({ plugin: 'context-watcher', surface: 'terminal', ...BAND })
    const runs = ((await ui.findAll({ type: 'Text', text: /^█+$/ })) as any[]).filter(t => t.props.color)
    await ui.unmount()
    const total = runs.reduce((n, r) => n + r.text.length, 0)
    let pos = 0
    for (const r of runs) {
      if (r.props.color !== '#5B8DEF') return pos / Math.max(1, total)
      pos += r.text.length
    }
    return -1
  }
  await $.prompt.submit({ text: 'hi' } as any)
  await clock.advance(4000)
  await $.session.measure({ context: { tokens: 200_000, window: 1_000_000, percent: 20 }, rateLimits: [], changed: ['context'] } as any)
  await clock.advance(300)
  const early = await shimmerAt()
  await clock.advance(900)
  const late = await shimmerAt()
  // Early in the animation the band sits toward the right; later it has moved left.
  expect(early > late && late >= 0).toBe(true)
})
