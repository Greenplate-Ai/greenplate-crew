// The fleet engine knows nothing about kitchens: a two-agent fleet over a made-up service runs on it.
import { describe, expect, it } from 'vitest'
import { call, say, scripted } from '../src/fleet/model.js'
import { runFleet, type Fleet, type Service } from '../src/fleet/runtime.js'

const service: Service & { seen: string[] } = {
  seen: [],
  async call(tool) { this.seen.push(tool); return { ok: true, text: '{"tickets":3}' } },
}

const fleet: Fleet = {
  lead: 'lead',
  rules: 'Be brief.',
  agents: {
    lead: { name: 'lead', job: 'Route support requests.', tools: [{ via: 'handoff', kind: 'read', to: 'triage', def: { name: 'ask_triage', description: 'triage', parameters: { type: 'object', properties: { task: { type: 'string' } } } } }] },
    triage: { name: 'triage', job: 'Count open tickets.', tools: [{ via: 'service', kind: 'read', def: { name: 'tickets_open', description: 'open tickets', parameters: { type: 'object', properties: {} } } }] },
  },
}

describe('fleet engine', () => {
  it('runs any fleet, not just the kitchen crew', async () => {
    const model = scripted([call('ask_triage', { task: 'how many open?' }), call('tickets_open'), say('3 open.'), say('There are 3 open tickets.')])
    const r = await runFleet(fleet, 'How many tickets are open?', { model, service, context: {}, canWrite: false, budget: { maxTurns: 5, maxServiceCalls: 5, maxUsd: 1 }, confirm: async () => true })
    expect(r.answer).toBe('There are 3 open tickets.')
    expect(service.seen).toEqual(['tickets_open'])
    expect(r.log.steps.map((s) => s.agent)).toContain('triage')
  })
})
