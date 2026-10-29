import { describe, expect, it } from 'vitest'
import { askCrew, rowNamed, type CrewOptions } from '../src/kitchen/crew.js'
import { spokenQuestion } from '../src/kitchen/speak.js'
import { fakeKitchen } from '../src/kitchen/service.js'
import { call, say, scripted } from '../src/fleet/model.js'

const kitchen = () => fakeKitchen({
  pantry: [{ name: 'eggs' }],
  plan: [{ date: '2026-10-27', slot: 'dinner', recipeId: 'r1', title: 'Fried rice' }],
  recipes: { r1: { title: 'Fried rice', servings: 2, ingredients: [{ qty: 2, name: 'egg' }, { qty: 2, name: 'green onions' }] } },
})

const opts = (over: Partial<CrewOptions>): CrewOptions => ({
  model: scripted([say('ok')]),
  kitchen: kitchen(),
  canWrite: true,
  budget: { maxTurns: 6, maxServiceCalls: 40, maxUsd: 1 },
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

  it('the lead fans out to several specialists in parallel', async () => {
    let active = 0
    let peak = 0
    const slow = (text: string) => ({ text, toolCalls: [], inputTokens: 100, outputTokens: 10 })
    const fanOutTurn = { text: '', toolCalls: [{ id: 'a', name: 'ask_planner', args: { task: 'repair the week' } }, { id: 'b', name: 'ask_shopper', args: { task: 'update the list' } }, { id: 'c', name: 'ask_pantry', args: { task: 'what to use first' } }], inputTokens: 600, outputTokens: 60 }
    let leadTurns = 0
    const model = {
      id: 'probe', price: { input: 1, output: 4 },
      async turn(messages: { role: string; content: string }[]) {
        const system = messages[0]?.content ?? ''
        if (system.startsWith('You run the household')) return leadTurns++ === 0 ? fanOutTurn : slow('Week fixed: Tuesday moved to Thursday, rice added.')
        active++; peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
        return slow('done')
      },
    }
    const r = await askCrew('Tuesday fell through, fix my week', 'general', opts({ model }))
    expect(peak).toBe(3)
    expect(r.log.steps.some((s) => s.note?.startsWith('in parallel: ask_planner, ask_shopper, ask_pantry'))).toBe(true)
    expect(r.answer).toContain('Week fixed')
  })

  it('an agent cannot use another agent’s tools', async () => {
    const model = scripted([call('kitchen_plan_add', { date: '2026-10-27', slot: 'dinner', recipeId: 'r1' }), say('done')])
    const r = await askCrew('plan dinner', 'general', opts({ model }))
    expect(r.log.steps.some((s) => s.agent === 'lead' && s.outcome === 'refused')).toBe(true)
  })

  it('on a plan that cannot save, writes become suggestions', async () => {
    const k = kitchen()
    const model = scripted([call('ask_pantry', { task: 'add milk' }), call('kitchen_pantry_add', { name: 'milk' }), say('Suggested.'), say('I suggested adding milk.')])
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
    const r = await askCrew('check', 'general', opts({ model, budget: { maxTurns: 20, maxServiceCalls: 3, maxUsd: 1 } }))
    expect(r.stoppedBecause).toBe('service_calls')
    expect(r.log.serviceCalls).toBeLessThanOrEqual(3)
  })

  it('changes asked for together get one question, and every one is made on a yes', async () => {
    const k = fakeKitchen({ grocery: [] })
    const asked: string[] = []
    const adds = { text: '', toolCalls: ['milk', 'eggs', 'bread'].map((name) => ({ id: `c-${name}`, name: 'kitchen_grocery_add', args: { name } })), inputTokens: 500, outputTokens: 30 }
    const model = scripted([call('ask_shopper', { task: 'add milk, eggs and bread' }), adds, say('Added.'), say('Added milk, eggs and bread.')])
    await askCrew('add milk, eggs and bread to my list', 'general', opts({ model, kitchen: k, confirm: async (q) => { asked.push(q); return true } }))
    expect(asked).toHaveLength(1)
    expect(spokenQuestion(asked[0]!)).toBe('The shopper wants to add milk, eggs and bread to the grocery list. Yes or no?')
    expect(k.calls.filter((c) => c === 'kitchen_grocery_add')).toHaveLength(3)
  })

  it('ticks a grocery item off by the name said, after a yes', async () => {
    const k = fakeKitchen({ grocery: [{ name: 'Whole milk' }, { name: 'Limes' }] })
    const asked: string[] = []
    const model = scripted([call('ask_shopper', { task: 'got the limes' }), call('grocery_check_off', { name: 'the limes' }), say('Ticked.'), say('Limes are checked off.')])
    await askCrew('I got the limes', 'shopping', opts({ model, kitchen: k, confirm: async (q) => { asked.push(q); return true } }))
    expect(spokenQuestion(asked[0]!)).toBe('The shopper wants to check off the limes. Yes or no?')
    expect(k.calls).toContain('kitchen_grocery_update')
    const list = (await k.call('kitchen_grocery_list')).data as { items: { name: string; ticked: boolean }[] }
    expect(list.items.find((i) => i.name === 'Limes')?.ticked).toBe(true)
  })

  it('finds the row the person meant', () => {
    const rows = [{ id: '1', name: 'Whole milk' }, { id: '2', name: 'Eggs' }]
    expect(rowNamed(rows, 'the eggs')?.id).toBe('2')
    expect(rowNamed(rows, 'milk')?.id).toBe('1')
    expect(rowNamed(rows, 'saffron')).toBeUndefined()
  })
})
