// Every step the crew takes, in order: which agent, what it called, what happened, what it cost.
// This is what the person (and a judge) can check after any run.
export interface Step {
  at: string
  agent: string
  kind: 'think' | 'tool' | 'handoff' | 'ask' | 'stop'
  tool?: string
  outcome?: 'ok' | 'refused' | 'limit' | 'declined' | 'preview' | 'error'
  note?: string
  inputTokens?: number
  outputTokens?: number
  usd?: number
}

export class RunLog {
  readonly steps: Step[] = []
  constructor(readonly runId: string, readonly request: string) {}
  add(s: Omit<Step, 'at'>): void { this.steps.push({ at: new Date().toISOString(), ...s }) }
  get usd(): number { return this.steps.reduce((a, s) => a + (s.usd ?? 0), 0) }
  get serviceCalls(): number { return this.steps.filter((s) => s.kind === 'tool' && s.outcome !== 'preview' && s.outcome !== 'declined').length }
  /** One line per step, for the phone and the demo's run-log shot. */
  lines(): string[] {
    return this.steps.map((s) => [s.agent.padEnd(8), s.kind.padEnd(7), s.tool ?? '', s.outcome ?? '', s.note ?? ''].join(' ').trimEnd())
  }
}
