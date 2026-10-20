import { expect, mock, test } from 'claude-code/testing'

const at = (cols: number) => ({ component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: cols } }) as const
const PANE = { component: 'Pane', requestId: 'run-watcher-list', props: { title: 'Background tasks', isFocused: false, bodyColumns: 60, placement: 'dock' } } as const
const note = (id: string, status: string, extra = '') => `<task-notification><task-id>${id}</task-id><status>${status}</status>${extra}</task-notification>`

test('background tasks: categories and tags, intro label, finish and fail, panel, 10-minute hide', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let n = 0
  let isBackground = true
  let reads = 0
  on('tool.call', () =>
    isBackground
      ? ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: `b${++n}` }, text: `Command running in background with ID: b${n}. Output is being written to: /tmp/tasks/b${n}.output`, ref: 'r' }) as any
      : ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok', ref: 'r' }) as any,
  )
  on('prompt.submit', (_, e) => ({ text: e.text }) as any)
  on('process.run', () => {
    reads++
    return { value: { exitCode: 0, stdout: 'loading\nepoch 3/10 loss 0.41\n 45%|████▌     | 450/1000\n', stderr: '' } } as any
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.close', () => ({ value: undefined }) as any)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  const text = async (re: RegExp, cols = 140) => {
    const ui = await $.ui.mount({ plugin: 'run-watcher', surface: 'terminal', ...at(cols) })
    const found = await ui.find({ type: 'Text', text: re })
    await ui.unmount()
    return found
  }

  // A foreground command is ignored.
  isBackground = false
  await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(await text(/Background task/)).toBeUndefined()
  isBackground = true

  await $.tool.call({ tool: 'Bash', command: 'python run_batch.py --provider anthropic --judge', description: 'Score answers with Claude batch API', run_in_background: true } as any)
  await $.tool.call({ tool: 'Bash', command: 'python finetune.py --lora --model llama3 && ollama create v3', description: 'Fine-tune v3', run_in_background: true } as any)
  // New: "Background task" first, then the category with its tags.
  expect(await text(/Background task/)).toBeDefined()
  await clock.advance(2000)
  expect(await text(/API calls/)).toBeDefined()
  expect(await text(/anthropic, batch, eval/)).toBeDefined()
  expect(await text(/LLM run/)).toBeDefined()
  expect(await text(/fine-tuning, ollama/)).toBeDefined()
  // No output is read while the band is collapsed.
  expect(reads).toBe(0)

  // One finishes, one fails with an exit code.
  await $.prompt.submit({ text: note('b1', 'completed'), origin: { kind: 'task-notification' } } as any)
  await $.prompt.submit({ text: note('b2', 'failed', 'Exited with code 3'), origin: { kind: 'task-notification' } } as any)
  expect(await text(/✔/)).toBeDefined()
  expect(await text(/exit 3/)).toBeDefined()

  // Every width draws on both surfaces.
  for (const cols of [20, 60, 120, 400]) {
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'run-watcher', surface, ...at(cols) })
      const svgs = (await ui.findAll({ type: 'Svg' } as any)) as any[]
      if (surface === 'desktop') {
        expect(svgs.length).toBe(6)
        expect(svgs.every(s => s.props.width > 0 && !s.props.source.includes('NaN'))).toBe(true)
      }
      await ui.unmount()
    }
  }

  // Each finished task's output was read once, when it ended.
  expect(reads).toBe(2)

  // Expanding reads the output: the panel shows the log and its percentage.
  const band = await $.ui.mount({ plugin: 'run-watcher', surface: 'terminal', ...at(140) })
  await band.press({ key: 'run-watcher' })
  await band.unmount()
  // Nothing is running, so expanding reads nothing more.
  expect(reads).toBe(2)
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'run-watcher', surface, ...PANE })
    if (surface === 'terminal') {
      expect(await pane.find({ type: 'Text', text: /450\/1000/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /45%/ })).toBeDefined()
    } else {
      const svgs = (await pane.findAll({ type: 'Svg' } as any)) as any[]
      expect(svgs.length).toBe(1 + 2 * 4)
      expect(svgs.every(s => s.props.alt && !s.props.source.includes('NaN'))).toBe(true)
    }
    await pane.unmount()
  }

  await clock.advance(11 * 60 * 1000)
  const gone = await $.ui.mount({ plugin: 'run-watcher', surface: 'terminal', ...PANE })
  expect(await gone.find({ type: 'Text', text: /No background tasks/ })).toBeDefined()
  await gone.unmount()
})
