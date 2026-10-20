import { expect, mock, test } from 'claude-code/testing'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 140 } } as const

test('a task a subagent started ends when the stop list no longer has it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bsub1' }, text: 'Command running in background with ID: bsub1. Output is being written to: /tmp/t/bsub1.output', ref: 'r' }) as any)
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'done\n', stderr: '' } }) as any)
  on('classic.Stop', () => ({}) as any)
  on('classic.SubagentStop', () => ({}) as any)
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

  await $.tool.call({ tool: 'Bash', command: 'sleep 60', description: 'Wait 60 seconds in background', run_in_background: true, agentId: 'a1' } as any)
  await clock.advance(5000)
  // Still listed as in flight: keeps running.
  await $.classic.SubagentStop({ background_tasks: [{ id: 'bsub1', type: 'shell', status: 'running', description: 'x' }] } as any)
  expect(await find(/✔/)).toBeUndefined()
  // Gone from the list: finished.
  await $.classic.Stop({ background_tasks: [] } as any)
  expect(await find(/✔/)).toBeDefined()
})
