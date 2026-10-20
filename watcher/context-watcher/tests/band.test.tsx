import { expect, mock, test } from 'claude-code/testing'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 140 } } as const

test('appears on a prompt, follows the figures, hides 10 min after the turn', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as any)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 40_000, window: 200_000, percent: 20 }, rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-14T12:30:00Z' }] } }) as any)
  on('prompt.submit', () => ({ text: 'hi' }) as any)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'x1' }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  const find = async (text: RegExp) => {
    const ui = await $.ui.mount({ plugin: 'context-watcher', surface: 'terminal', ...BAND })
    const found = await ui.find({ type: 'Text', text })
    await ui.unmount()
    return found
  }
  const svg = async () => {
    const ui = await $.ui.mount({ plugin: 'context-watcher', surface: 'desktop', ...BAND })
    const found = await ui.find({ type: 'Text', text: /Context/ })
    await ui.unmount()
    return found
  }

  expect(await find(/Opus/)).toBeUndefined()
  expect(await svg()).toBeUndefined()

  await $.prompt.submit({ text: 'hi' } as any)
  expect(await find(/Opus 5\.5/)).toBeDefined()
  expect(await find(/20%/)).toBeDefined()
  // Working: the name glows in its family color.
  expect((await find(/Opus 5\.5/))?.props.color).toBeDefined()
  expect(await find(/resets in 2h 30m/)).toBeDefined()
  expect(await svg()).toBeDefined()

  await $.session.measure({ context: { tokens: 90_000, window: 200_000, percent: 45 }, rateLimits: [{ kind: 'five_hour', percentUsed: 14, resetsAt: '2026-10-14T12:30:00Z' }, { kind: 'seven_day', percentUsed: 60 }], changed: ['context', 'rateLimits'] })
  expect(await find(/45%/)).toBeDefined()
  // A grown context bar shimmers across its fill, then settles back to its color.
  await clock.advance(600)
  const shimmering = await $.ui.mount({ plugin: 'context-watcher', surface: 'terminal', ...BAND })
  const midColors = (await shimmering.findAll({ type: 'Text', text: /█/ })).map(t => t.props.color).filter(Boolean)
  await shimmering.unmount()
  await clock.advance(1400)
  const settled = await $.ui.mount({ plugin: 'context-watcher', surface: 'terminal', ...BAND })
  const endColors = (await settled.findAll({ type: 'Text', text: /█/ })).map(t => t.props.color).filter(Boolean)
  expect(midColors.some(c => c !== '#5B8DEF')).toBe(true)
  expect(endColors).toEqual(['#5B8DEF'])
  // Usage sits underneath on its own thin track.
  expect((await settled.find({ type: 'Text', text: /━/ }))?.props.color).toBe('#D97757')
  await settled.unmount()


  expect(await find(/14%/)).toBeDefined()
  expect(await find(/60%/)).toBeUndefined()

  // A running agent on another model joins the carousel, and leaves when it ends.
  await $.agent.spawn({ prompt: 'x', subagentType: 'context-loader' })
  expect(await find(/Opus 5\.5/)).toBeDefined()
  await clock.advance(2600)
  expect(await find(/Haiku 5\.5/)).toBeDefined()
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 'x', agentId: 'x1', reason: 'answer' })
  expect(await find(/Haiku/)).toBeUndefined()

  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  // Idle: the name rests in plain white.
  expect((await find(/Opus 5\.5/))?.props.color).toBeUndefined()
  await clock.advance(9 * 60 * 1000)
  expect(await find(/Opus/)).toBeDefined()
  await clock.advance(60 * 1000 + 1000)
  expect(await find(/Opus/)).toBeUndefined()
})
