import { expect, mock, test } from 'claude-code/testing'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 140 } } as const
const PANE = { component: 'Pane', requestId: 'run-watcher-list', props: { title: 'Background tasks', isFocused: false, bodyColumns: 60, placement: 'dock' } } as const

test('settings, cost tag, pause key and open log', { options: { lingerMinutes: 2, extraPatterns: 'Experiment: run_thesis' } } as any, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let n = 0
  const opened: string[] = []
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: `b${++n}` }, text: `Output is being written to: /tmp/t/b${n}.output`, ref: 'r' }) as any)
  on('prompt.submit', (_, e) => ({ text: e.text }) as any)
  on('process.run', (_, e: any) => {
    if (e.argv?.[0] === 'open') {
      opened.push(e.argv[1])
    }
    return { value: { exitCode: 0, stdout: 'batch 40/40 done\nused 12,400 tokens, cost $0.38\n', stderr: '' } } as any
  })
  on('ui.press', (_, e) => ({ element: e.element }) as any)
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const find = async (re: RegExp) => {
    const ui = await $.ui.mount({ plugin: 'run-watcher', surface: 'terminal', ...BAND })
    const found = await ui.find({ type: 'Text', text: re })
    await ui.unmount()
    return found
  }

  await $.tool.call({ tool: 'Bash', command: 'python run_thesis.py --cfg a', description: 'Thesis run', run_in_background: true } as any)
  await $.tool.call({ tool: 'Bash', command: 'python score.py --provider openai', description: 'Score answers', run_in_background: true } as any)
  await clock.advance(2000)
  // A pattern from settings puts the thesis run under Experiment.
  expect(await find(/Experiment/)).toBeDefined()

  // The API run's log shows its spend once it ends.
  await $.prompt.submit({ text: '<task-notification><task-id>b2</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' } } as any)
  expect(await find(/12\.4k tokens · \$0\.38/)).toBeDefined()

  // The pause key (from any watcher) hides the band until the next prompt.
  const desk = await $.ui.mount({ plugin: 'run-watcher', surface: 'desktop', ...BAND })
  await desk.press({ key: 'watcher-pause' })
  await desk.unmount()
  expect(await find(/Experiment/)).toBeUndefined()
  await $.prompt.submit({ text: 'next', origin: { kind: 'composer' } } as any)
  expect(await find(/Experiment/)).toBeDefined()

  // Open log, in the expanded panel.
  const band = await $.ui.mount({ plugin: 'run-watcher', surface: 'desktop', ...BAND })
  await band.press({ key: 'run-watcher' })
  await band.unmount()
  const pane = await $.ui.mount({ plugin: 'run-watcher', surface: 'desktop', ...PANE })
  await pane.press({ key: 'open-log-b2' })
  await pane.unmount()
  expect(opened).toEqual(['/tmp/t/b2.output'])
})
