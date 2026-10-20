export type Meter = {
  model: string
  agentModels: Record<string, string>
  contextTokens: number | null
  contextWindow: number
  contextPercent: number | null
  usagePercent: number | null
  usageResetsAt: string | null
  isActive: boolean
  isVisible: boolean
  // Where the pace is measured from: the first reading in this 5-hour window.
  paceFrom?: { at: number; percent: number; resetsAt: string | null }
  // The effort each loop asks for: the main loop's, and each running agent's by id.
  effort?: string
  agentEfforts?: Record<string, string>
}

export type Shown = { context: number; usage: number; carousel: number; carouselAt: number; breath: number; contextGlowAt: number; usageGlowAt: number; compactAt?: number }

declare module 'claude-code' {
  interface PluginState {
    'context-watcher': { meter: Meter; tick: number; shown: Shown; isPaused: boolean }
  }
}
