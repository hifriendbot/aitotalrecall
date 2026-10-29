export type RecallSource = 'recall' | 'context' | 'preflight' | 'saved' | 'search'

export type RecallItem = {
  id: string
  subject: string
  snippet: string
  full: string
  importance?: number
  scope?: string
  via: RecallSource
  at: number
  turn: number
  callId?: string
}

export type RecallRule = { slug: string; text: string; id?: string }

export type RecallTab = 'recalled' | 'learned' | 'rules'

export type RecallCallKind = 'recall' | 'context' | 'preflight' | 'save' | 'search'

/** One memory-server call the transcript draws as a card. */
export type RecallCall = {
  id: string
  kind: RecallCallKind
  query: string
  count: number
  rules: number
  subjects: string[]
  memoryId?: string
  isDone: boolean
  isError: boolean
}

export type RecallStats = {
  recalls: number
  saves: number
  contextLoads: number
  lastEvent: string
  lastAt: number
  isBusy: boolean
  project: string
  flash: string
  turn: number
  isConnected: boolean
}

export type RecallLifetime = { recalls: number; saves: number; sessions: number }

declare module 'claude-code' {
  interface PluginState {
    aitotalrecall: {
      recalled: RecallItem[]
      learned: RecallItem[]
      rules: RecallRule[]
      calls: Record<string, RecallCall>
      stats: RecallStats
      tab: RecallTab
      expanded: string
      pulse: number[]
      isBandHidden: boolean
      lifetime: RecallLifetime
    }
  }
}
