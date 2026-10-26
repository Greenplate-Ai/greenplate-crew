// The fleet engine: a lead that hands work to specialists (in parallel when it asks for several),
// per-agent tool permissions, approval before sensitive changes, budgets, the service's own limits,
// an answer guard, and a run log of every step. Nothing here knows about kitchens.
import type { Model, Msg, ToolCall, ToolDef } from './model.js'
import { RunLog } from './runlog.js'

export type Kind = 'read' | 'write'

/** A call to the deployment's service (for GreenplateAi: its MCP plug-in). */
export interface ServiceTool { via: 'service'; def: ToolDef; kind: Kind; askFirst?: boolean }
/** A tool computed inside the fleet; it reports how many service calls it spent. */
export interface LocalTool<C = unknown> { via: 'local'; def: ToolDef; kind: Kind; run(args: Record<string, unknown>, env: LocalEnv<C>): Promise<{ text: string; serviceCalls: number; note?: string }> }
export interface HandoffTool { via: 'handoff'; def: ToolDef; kind: 'read'; to: string }
export type Tool<C = unknown> = ServiceTool | LocalTool<C> | HandoffTool

export interface Agent<C = unknown> { name: string; job: string; tools: Tool<C>[] }

export interface ServiceResult { ok: boolean; text: string; limit?: boolean }
export interface Service { call(tool: string, args: Record<string, unknown>): Promise<ServiceResult> }

export interface LocalEnv<C> { service: Service; context: C }

export interface Fleet<C = unknown> {
  lead: string
  agents: Record<string, Agent<C>>
  /** Rules every agent follows, appended to its job. */
  rules: string
  /** Checks the final answer; returns what it caught, or null. */
  guard?: { check(answer: string): string | null; rewrite: string; fallback: string }
}

export interface Budget { maxTurns: number; maxServiceCalls: number; maxUsd: number }
export interface RunOptions<C = unknown> {
  model: Model
  service: Service
  context: C
  /** May the fleet save changes for this account? (Free plans: suggestions only.) */
  canWrite: boolean
  budget: Budget
  /** Asked before any tool marked askFirst. */
  confirm(question: string): Promise<boolean>
}

export type Stop = 'done' | 'turns' | 'service_calls' | 'cost' | 'limit'
export interface FleetResult { answer: string; stoppedBecause: Stop; log: RunLog }

interface Run<C> { fleet: Fleet<C>; opts: RunOptions<C>; log: RunLog; calls: { n: number } }

export async function runFleet<C>(fleet: Fleet<C>, task: string, opts: RunOptions<C>, runId = `run-${Date.now()}`): Promise<FleetResult> {
  const log = new RunLog(runId, task)
  const run: Run<C> = { fleet, opts, log, calls: { n: 0 } }
  const r = await runAgent(run, fleet.lead, task)
  let answer = r.answer
  const hit = fleet.guard?.check(answer)
  if (fleet.guard && hit) {
    log.add({ agent: fleet.lead, kind: 'think', outcome: 'refused', note: `answer guard: "${hit}"` })
    const lead = fleet.agents[fleet.lead]!
    const t = await opts.model.turn([{ role: 'system', content: `${lead.job} ${fleet.rules}` }, { role: 'user', content: `${fleet.guard.rewrite}\n\nAnswer to rewrite: "${answer}"` }], [])
    log.add({ agent: fleet.lead, kind: 'think', inputTokens: t.inputTokens, outputTokens: t.outputTokens, usd: cost(opts.model, t.inputTokens, t.outputTokens) })
    answer = fleet.guard.check(t.text) ? fleet.guard.fallback : t.text
  }
  log.add({ agent: fleet.lead, kind: 'stop', note: r.stoppedBecause })
  return { answer, stoppedBecause: r.stoppedBecause, log }
}

const cost = (m: Model, i: number, o: number): number => (i * m.price.input + o * m.price.output) / 1e6

async function runAgent<C>(run: Run<C>, name: string, task: string): Promise<{ answer: string; stoppedBecause: Stop }> {
  const agent = run.fleet.agents[name]
  if (!agent) return { answer: `No agent named ${name}.`, stoppedBecause: 'done' }
  const { model, budget } = run.opts
  const messages: Msg[] = [{ role: 'system', content: `${agent.job} ${run.fleet.rules}` }, { role: 'user', content: task }]
  const byName = new Map(agent.tools.map((t) => [t.def.name, t]))

  for (let turnNo = 0; turnNo < budget.maxTurns; turnNo++) {
    const turn = await model.turn(messages, agent.tools.map((t) => t.def))
    run.log.add({ agent: name, kind: 'think', inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, usd: cost(model, turn.inputTokens, turn.outputTokens) })
    messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls })
    if (turn.toolCalls.length === 0) return { answer: turn.text, stoppedBecause: 'done' }
    if (run.log.usd > budget.maxUsd) return { answer: turn.text || 'I stopped to stay inside the budget.', stoppedBecause: 'cost' }

    // Hand-offs issued together run in parallel (the fleet fans out); other tools run in order so
    // writes never race each other.
    const fanOut = turn.toolCalls.length > 1 && turn.toolCalls.every((c) => byName.get(c.name)?.via === 'handoff')
    if (fanOut) run.log.add({ agent: name, kind: 'handoff', note: `in parallel: ${turn.toolCalls.map((c) => c.name).join(', ')}` })
    const outs: { text: string; stop?: Stop }[] = []
    if (fanOut) outs.push(...(await Promise.all(turn.toolCalls.map((c) => runTool(run, name, byName.get(c.name), c)))))
    else for (const c of turn.toolCalls) { const o = await runTool(run, name, byName.get(c.name), c); outs.push(o); if (o.stop) break }

    for (const [i, out] of outs.entries()) {
      if (out.stop) return { answer: out.text, stoppedBecause: out.stop }
      messages.push({ role: 'tool', toolCallId: turn.toolCalls[i]!.id, content: out.text })
    }
  }
  return { answer: 'I ran out of steps before finishing.', stoppedBecause: 'turns' }
}

async function runTool<C>(run: Run<C>, agent: string, tool: Tool<C> | undefined, c: ToolCall): Promise<{ text: string; stop?: Stop }> {
  const { opts, log } = run
  if (!tool) {
    log.add({ agent, kind: 'tool', tool: c.name, outcome: 'refused', note: 'not this agent’s tool' })
    return { text: `${c.name} is not one of your tools.` }
  }
  if (tool.via === 'handoff') {
    log.add({ agent, kind: 'handoff', tool: tool.to, note: String(c.args.task ?? '') })
    const r = await runAgent(run, tool.to, String(c.args.task ?? ''))
    return r.stoppedBecause === 'done' ? { text: r.answer } : { text: r.answer, stop: r.stoppedBecause }
  }
  if (tool.kind === 'write' && !opts.canWrite) {
    log.add({ agent, kind: 'tool', tool: tool.def.name, outcome: 'preview', note: 'this plan shows suggestions only' })
    return { text: 'This account’s plan shows suggestions only. Describe the change instead of saving it.' }
  }
  if (tool.via === 'service' && tool.askFirst) {
    const yes = await opts.confirm(`${agent} wants to ${c.name}: ${JSON.stringify(c.args)}`)
    log.add({ agent, kind: 'ask', tool: c.name, outcome: yes ? 'ok' : 'declined' })
    if (!yes) return { text: 'The person said no. Do not make this change.' }
  }
  if (run.calls.n >= opts.budget.maxServiceCalls) {
    log.add({ agent, kind: 'stop', note: 'service call budget reached' })
    return { text: 'I stopped to stay inside today’s plan limit.', stop: 'service_calls' }
  }
  if (tool.via === 'local') {
    try {
      const r = await tool.run(c.args, { service: opts.service, context: opts.context })
      run.calls.n += r.serviceCalls
      log.add({ agent, kind: 'tool', tool: c.name, outcome: 'ok', note: r.note })
      return { text: r.text }
    } catch (e) {
      log.add({ agent, kind: 'tool', tool: c.name, outcome: 'error', note: (e as Error).message })
      return { text: `That failed: ${(e as Error).message}` }
    }
  }
  run.calls.n++
  const r = await opts.service.call(c.name, c.args)
  if (r.limit) {
    log.add({ agent, kind: 'tool', tool: c.name, outcome: 'limit', note: r.text })
    return { text: r.text, stop: 'limit' }
  }
  log.add({ agent, kind: 'tool', tool: c.name, outcome: r.ok ? 'ok' : 'refused' })
  return { text: r.text }
}
