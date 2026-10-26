import { describe, expect, it } from 'vitest'
import { askCrew, type CrewOptions } from '../src/crew.js'
import { fakeKitchen } from '../src/kitchen.js'
import { call, say, scripted } from '../src/model.js'

const kitchen = () => fakeKitchen({
  pantry: [{ name: 'eggs' }],
  plan: [{ date: '2026-10-27', slot: 'dinner', recipeId: 'r1', title: 'Fried rice' }],
  recipes: { r1: { title: 'Fried rice', servings: 2, ingredients: [{ qty: 2, name: 'egg' }, { qty: 2, name: 'green onions' }] } },
})

const opts = (over: Partial<CrewOptions>): CrewOptions => ({
  model: scripted([say('ok')]),
  kitchen: kitchen(),
  canWrite: true,
  budget: { maxTurns: 6, maxKitchenCalls: 40, maxUsd: 1 },
  confirm: async () => true,
  today: '2026-10-26',
  ...over,
})

describe('the crew', () => {
  it('lead hands shopping to the shopper, who builds the list', async () => {
    const model = scripted([
      call('ask_shopper', { task: 'What is missing for this week?' }),
      call('shopping_list', { from: '2026-10-26', to: '2026-11-01' }),
      say('Green onions. Everything else is home.'),
      say('You just need green onions.'),
    ])
    const r = await askCrew("I'm at the store, what am I missing?", 'shopping', opts({ model }))
    expect(r.stoppedBecause).toBe('done')
    expect(r.answer).toBe('You just need green onions.')
    expect(r.log.steps.some((s) => s.kind === 'handoff' && s.tool === 'shopper')).toBe(true)
    expect(r.log.steps.some((s) => s.tool === 'shopping_list' && s.note === '1 to buy, 1 already home')).toBe(true)
  })

  it('an agent cannot use another agent’s tools', async () => {
    const model = scripted([call('kitchen_plan_add', { date: '2026-10-27', slot: 'dinner', recipeId: 'r1' }), say('done')])
    const r = await askCrew('plan dinner', 'general', opts({ model }))
    expect(r.log.steps.some((s) => s.agent === 'lead' && s.outcome === 'refused')).toBe(true)
  })

  it('on a plan that cannot save, writes become suggestions', async () => {
    const k = kitchen()
    const model = scripted([call('ask_shopper', { task: 'add milk' }), call('kitchen_pantry_add', { name: 'milk' }), say('Suggested.'), say('I suggested adding milk.')])
    const r = await askCrew('add milk to the pantry', 'general', opts({ model, kitchen: k, canWrite: false }))
    expect(r.log.steps.some((s) => s.outcome === 'preview')).toBe(true)
    expect(k.calls).not.toContain('kitchen_pantry_add')
  })

  it('asks before changing the plan, and a no stops it', async () => {
    const k = kitchen()
    const model = scripted([call('ask_planner', { task: 'move dinner' }), call('kitchen_plan_add', { date: '2026-10-29', slot: 'dinner', recipeId: 'r1' }), say('Left it.'), say('Okay, I left the plan alone.')])
    const r = await askCrew('move tonight to Thursday', 'general', opts({ model, kitchen: k, confirm: async () => false }))
    expect(r.log.steps.some((s) => s.kind === 'ask' && s.outcome === 'declined')).toBe(true)
    expect(k.calls).not.toContain('kitchen_plan_add')
  })

  it('stops cleanly when GreenplateAi says the daily limit is reached', async () => {
    const model = scripted([call('ask_pantry', { task: 'what is going off' }), call('kitchen_pantry_list'), say('x')])
    const r = await askCrew("what's going off?", 'pantry_check', opts({ model, kitchen: fakeKitchen({ limitAfter: 0 }) }))
    expect(r.stoppedBecause).toBe('limit')
    expect(r.answer).toContain("today's limit")
  })

  it('never goes past the kitchen call budget', async () => {
    const model = scripted([call('ask_pantry', { task: 'check' }), call('kitchen_pantry_list')])
    const r = await askCrew('check', 'general', opts({ model, budget: { maxTurns: 20, maxKitchenCalls: 3, maxUsd: 1 } }))
    expect(r.stoppedBecause).toBe('kitchen_calls')
    expect(r.log.kitchenCalls).toBeLessThanOrEqual(3)
  })
})
