export type RunRow = {
  id: string
  command: string
  description: string
  category: string
  tags: string[]
  startedAt: number
  endedAt: number | null
  status: 'running' | 'done' | 'failed'
  exitCode: number | null
  outputPath: string | null
  percent: number | null
  tail: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'run-watcher': { rows: RunRow[]; tick: number; isPanelOpen: boolean; isPaused: boolean }
  }
}
