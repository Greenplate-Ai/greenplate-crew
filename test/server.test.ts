import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { call, say, scripted } from '../src/fleet/model.js'
import { crewServer } from '../src/kitchen/server.js'
import { fakeKitchen } from '../src/kitchen/service.js'

const TOKEN = 'test-token-0123456789abcdef'
let close: (() => void) | null = null
afterEach(() => { close?.(); close = null })

async function start(model = scripted([say('ok')]), eyes = async () => ({ item: null as string | null, confidence: 0 }), speak?: (t: string) => Promise<Buffer>) {
  const kitchen = fakeKitchen({
    pantry: [{ name: 'soy sauce' }, { name: 'eggs' }],
    plan: [{ date: '2026-10-27', slot: 'dinner', recipeId: 'r1', title: 'Fried rice' }],
    recipes: { r1: { title: 'Fried rice', servings: 2, ingredients: [{ name: 'egg' }, { name: 'green onions' }, { name: 'rice' }, { name: 'soy sauce' }] } },
  })
  const server = crewServer({ model, kitchen, eyes, speak, canWrite: true, appToken: TOKEN, today: () => '2026-10-26' })
  await new Promise<void>((r) => server.listen(0, r))
  close = () => server.close()
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const req = async (method: string, path: string, body?: unknown, token = TOKEN) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, body: (await r.json()) as Record<string, unknown> }
  }
  return req
}

const until = async <T>(f: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
  for (let i = 0; i < 50; i++) { const v = await f(); if (ok(v)) return v; await new Promise((r) => setTimeout(r, 10)) }
  throw new Error('timed out')
}

describe('crew service', () => {
  it('refuses requests without the app token', async () => {
    const req = await start()
    expect((await req('POST', '/ask', { request: 'hi' }, 'wrong')).status).toBe(401)
  })

  it('runs a request and returns the answer and the run log', async () => {
    const req = await start(scripted([say('You need green onions.')]))
    const { body } = await req('POST', '/ask', { request: 'what am I missing?', mode: 'shopping' })
    const run = await until(() => req('GET', `/runs/${body.runId}`), (r) => r.body.status === 'done')
    expect(run.body.answer).toBe('You need green onions.')
    expect(Array.isArray(run.body.steps)).toBe(true)
  })

  it('waits for the person before changing the plan', async () => {
    const model = scripted([call('ask_planner', { task: 'move dinner' }), call('kitchen_plan_add', { date: '2026-10-29', slot: 'dinner', recipeId: 'r1' }), say('Moved.'), say('Moved to Thursday.')])
    const req = await start(model)
    const { body } = await req('POST', '/ask', { request: 'move dinner to Thursday' })
    const waiting = await until(() => req('GET', `/runs/${body.runId}`), (r) => r.body.status === 'waiting')
    expect(String(waiting.body.question)).toContain('kitchen_plan_add')
    expect(waiting.body.spoken).toBe('The planner wants to put a recipe on the plan for 2026-10-29 dinner. Yes or no?')
    expect((await req('POST', `/runs/${body.runId}/answer`, { yes: false })).status).toBe(200)
    const done = await until(() => req('GET', `/runs/${body.runId}`), (r) => r.body.status === 'done')
    expect(done.body.answer).toBe('Moved to Thursday.')
  })

  it('live shopping: checks items off, catches what is home, and reminds at checkout', async () => {
    const seen = ['green onions', 'soy sauce', 'green onions']
    let i = 0
    const req = await start(undefined, async () => ({ item: seen[i++] ?? null, confidence: 0.9 }))
    const trip = await req('POST', '/shopping/start', { from: '2026-10-27', to: '2026-10-27' })
    expect(trip.body.needs).toEqual(['green onions', 'rice'])
    const a = await req('POST', `/shopping/${trip.body.tripId}/frame`, { jpegBase64: 'x' })
    expect(a.body.say).toBe('green onions, checked off. Still need rice.')
    const b = await req('POST', `/shopping/${trip.body.tripId}/frame`, { jpegBase64: 'x' })
    expect(b.body.say).toBe('You already have soy sauce at home.')
    const c = await req('POST', `/shopping/${trip.body.tripId}/frame`, { jpegBase64: 'x' })
    expect(c.body.say).toBeNull()
    const out = await req('POST', `/shopping/${trip.body.tripId}/checkout`)
    expect(out.body.say).toBe('Before you check out: you still need rice.')
  })

  it('asks for text before speaking, and says when no voice is configured', async () => {
    const withVoice = await start(undefined, undefined, async (t) => Buffer.from(`mp3:${t}`))
    expect((await withVoice('POST', '/speak', { text: '' })).status).toBe(400)
    close?.()
    const noVoice = await start()
    expect((await noVoice('POST', '/speak', { text: 'hi' })).status).toBe(404)
  })

  it('reports health without the app token, and names what is missing', async () => {
    const server = crewServer({ appToken: TOKEN, canWrite: false, missing: ['MODEL_API_KEY'] })
    await new Promise<void>((r) => server.listen(0, r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const h = await (await fetch(`${base}/health`)).json()
    expect(h).toEqual({ ok: true, voice: false, crew: false, missing: ['MODEL_API_KEY'] })
    const ask = await fetch(`${base}/ask`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{"request":"hi"}' })
    expect(ask.status).toBe(503)
    server.close()
  })
})
