import { expect, mock, test } from 'claude-code/testing'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } } as const
const PANE = { component: 'Pane', requestId: 'agent-watcher-list', props: { title: 'Agents', isFocused: false, bodyColumns: 50, placement: 'dock' } } as const

test('band shows 2 agents, steps aside while the panel is open, and hides 10 min after', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: `a${++n}` }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.close', () => ({ value: undefined }) as any)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  const count = async (surface: 'terminal' | 'desktop', props: any = BAND) => {
    const ui = await $.ui.mount({ plugin: 'agent-watcher', surface, ...props })
    const svgs = await ui.find({ type: 'Svg' } as any)
    const texts = await ui.find({ type: 'Text', text: /tools/ })
    await ui.unmount()
    return surface === 'desktop' ? svgs : texts
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await count(surface)).toBeUndefined()
  }

  for (const type of ['context-loader', 'run-analyst', 'brainstormer']) {
    await $.agent.spawn({ prompt: 'x', description: type, subagentType: type })
  }
  await clock.advance(2000)

  const term = await $.ui.mount({ plugin: 'agent-watcher', surface: 'terminal', ...BAND })
  expect(await term.find({ type: 'Text', text: /\+1/ })).toBeDefined()
  await term.press({ key: 'agent-watcher' })
  await term.unmount()

  // Panel open: the band steps aside; the panel lists all three.
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await count(surface)).toBeUndefined()
  }
  const pane = await $.ui.mount({ plugin: 'agent-watcher', surface: 'terminal', ...PANE } as any)
  expect(await pane.find({ type: 'Text', text: /context-loader/ })).toBeDefined()
  await pane.unmount()

  for (const id of ['a1', 'a2', 'a3']) {
    await $.turn.complete({ answer: 'done', durationMs: 2000, isAborted: false, turnId: id, agentId: id, reason: 'answer' })
  }
  await clock.advance(9 * 60 * 1000)

  await clock.advance(60 * 1000 + 1000)
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await count(surface)).toBeUndefined()
  }
})
