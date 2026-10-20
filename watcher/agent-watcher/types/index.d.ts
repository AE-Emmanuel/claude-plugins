export type AgentRow = {
  id: string
  type: string
  description: string
  model: string
  startedAt: number
  endedAt: number | null
  tools: number
  tokens: number
  status: 'running' | 'done' | 'failed'
}

declare module 'claude-code' {
  interface PluginState {
    'agent-watcher': { rows: AgentRow[]; tick: number; isPanelOpen: boolean; isPaused: boolean }
  }
}
