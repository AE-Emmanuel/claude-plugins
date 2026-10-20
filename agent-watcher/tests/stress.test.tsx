import { expect, mock, test } from 'claude-code/testing'

const at = (cols: number) => ({ component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: cols } }) as const
const PANE = { component: 'Pane', requestId: 'agent-watcher-list', props: { title: 'Agents', isFocused: false, bodyColumns: 30, placement: 'dock' } } as const

test('draws at any width on both surfaces, a failed agent included, and the panel stays whole', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `s${++n}` }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.close', () => ({ value: undefined }) as any)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  await $.agent.spawn({ prompt: 'x', description: 'a very long task description that would never fit a narrow band at all', subagentType: 'some-agent-with-a-really-long-name' })
  await $.agent.spawn({ prompt: 'x', description: 'short', subagentType: 'run-analyst' })
  await clock.advance(65_000)
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 's2t', agentId: 's2', reason: 'error' } as any)

  for (const cols of [20, 40, 80, 200, 400]) {
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'agent-watcher', surface, ...at(cols) })
      if (surface === 'desktop') {
        const svgs = await ui.findAll({ type: 'Svg' } as any)
        // Two rows of crab + text + track; every image has a description and a positive size.
        expect(svgs.length).toBe(6)
        for (const s of svgs as any[]) {
          expect(s.props.alt.length > 0).toBe(true)
          expect(s.props.width > 0).toBe(true)
          expect(s.props.source.includes('NaN')).toBe(false)
        }
      } else {
        expect(await ui.find({ type: 'Text', text: /1m05s/ })).toBeDefined()
      }
      await ui.unmount()
    }
  }

  // The running agent's crab and track keep the same image as the clock ticks; only its text changes.
  const sources = async () => {
    const ui = await $.ui.mount({ plugin: 'agent-watcher', surface: 'desktop', ...at(120) })
    const list = ((await ui.findAll({ type: 'Svg' } as any)) as any[]).map(s => s.props.source as string)
    await ui.unmount()
    return list
  }
  const before = await sources()
  await clock.advance(3000)
  const after = await sources()
  expect(after.filter((s, i) => s === before[i]).length >= 4).toBe(true)

  const pane = await $.ui.mount({ plugin: 'agent-watcher', surface: 'desktop', ...PANE })
  expect(((await pane.findAll({ type: 'Svg' } as any)) as any[]).length).toBe(7)
  await pane.unmount()
})
