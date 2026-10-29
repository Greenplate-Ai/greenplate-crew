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
    expect(h).toMatchObject({ ok: true, voice: false, talk: false, crew: false, missing: ['MODEL_API_KEY'] })
    const ask = await fetch(`${base}/ask`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{"request":"hi"}' })
    expect(ask.status).toBe(503)
    server.close()
  })

  it('talks with only the model when no kitchen is connected', async () => {
    const model = { id: 'stub', price: { input: 0, output: 0 }, turn: async () => ({ text: "I'm good, ready when you are.", toolCalls: [], inputTokens: 0, outputTokens: 0 }) }
    const server = crewServer({ appToken: TOKEN, canWrite: false, model, missing: ['GREENPLATE_MCP_TOKEN'] })
    await new Promise<void>((r) => server.listen(0, r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const auth = { authorization: `Bearer ${TOKEN}` }
    const { runId } = await (await fetch(`${base}/ask`, { method: 'POST', headers: auth, body: '{"request":"how are you"}' })).json()
    let run = { status: 'running', answer: '' }
    for (let i = 0; i < 20 && run.status === 'running'; i++) run = await (await fetch(`${base}/runs/${runId}`, { headers: auth })).json()
    expect(run).toMatchObject({ status: 'done', answer: "I'm good, ready when you are." })
    expect((await fetch(`${base}/shopping/start`, { method: 'POST', headers: auth, body: '{}' })).status).toBe(503)
    server.close()
  })

  it('passes the chat so far to the model', async () => {
    let seen: unknown[] = []
    const model = { id: 'stub', price: { input: 0, output: 0 }, turn: async (m: unknown[]) => { seen = m; return { text: 'Pasta, like you said.', toolCalls: [], inputTokens: 0, outputTokens: 0 } } }
    const server = crewServer({ appToken: TOKEN, canWrite: false, model })
    await new Promise<void>((r) => server.listen(0, r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const auth = { authorization: `Bearer ${TOKEN}` }
    const history = [{ who: 'You', text: 'I want pasta tonight' }, { who: 'Crew', text: 'Pasta it is.' }, { who: 'Bogus', text: 'ignored' }]
    const { runId } = await (await fetch(`${base}/ask`, { method: 'POST', headers: auth, body: JSON.stringify({ request: 'what did I want?', history }) })).json()
    for (let i = 0; i < 20; i++) { const r = await (await fetch(`${base}/runs/${runId}`, { headers: auth })).json(); if (r.status !== 'running') break }
    expect(seen.slice(1)).toEqual([{ role: 'user', content: 'I want pasta tonight' }, { role: 'assistant', content: 'Pasta it is.' }, { role: 'user', content: 'what did I want?' }])
    server.close()
  })

  it('answers simple questions in one quick call and hands real jobs to the crew', async () => {
    const kitchen = fakeKitchen({ pantry: [{ name: 'eggs' }], plan: [] })
    const quickSeen: string[] = []
    const talker = { id: 'quick', price: { input: 0, output: 0 }, turn: async (m: { content: string }[]) => {
      quickSeen.push(m[0]!.content)
      const q = m[m.length - 1]!.content
      return { text: q.includes('add') ? 'CREW' : 'You have eggs.', toolCalls: [], inputTokens: 0, outputTokens: 0 }
    } }
    const server = crewServer({ appToken: TOKEN, canWrite: false, kitchen, talker, model: scripted([say('Crew handled it.')]), today: () => '2026-10-26' })
    await new Promise<void>((r) => server.listen(0, r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const auth = { authorization: `Bearer ${TOKEN}` }
    const ask = async (request: string) => {
      const { runId } = await (await fetch(`${base}/ask`, { method: 'POST', headers: auth, body: JSON.stringify({ request }) })).json()
      return until(async () => (await fetch(`${base}/runs/${runId}`, { headers: auth })).json(), (r) => r.status !== 'running')
    }
    expect((await ask("what's in my pantry?")).answer).toBe('You have eggs.')
    expect(quickSeen[0]).toContain('eggs')
    expect((await ask('add milk')).answer).toBe('Crew handled it.')
    expect(kitchen.calls.filter((c) => c === 'kitchen_pantry_list')).toHaveLength(1) // snapshot reused
    server.close()
  })
})

describe('performance report', async () => {
  const { report } = await import('../src/kitchen/report.js')
  it('summarises answer, voice and app timings from the log', () => {
    const r = report(['ask answered in 1600 ms (quick, 2 lines of history)', 'ask answered in 9000 ms (crew, 0 lines of history)',
      'speak 40 chars -> 30000 bytes in 400 ms', 'app heard_to_spoken 2500 ms', 'app reconnected', 'app voice_failed (timeout)'])
    expect(r).toContain('| answer (quick) | 1 | 1.6 s |')
    expect(r).toContain('| app heard_to_spoken | 1 | 2.5 s |')
    expect(r).toContain('| app reconnected | 1 |')
    expect(r).toContain('| app voice_failed | 1 |')
  })
  it('counts wakes and false wakes, and shows what the false ones heard', () => {
    const r = report(['app woke (with request: hey crew whats for dinner)', 'app woke (bare: hey true)',
      'app wake_false (no request after Yes?)', 'app wake_missed (5 words)'])
    expect(r).toContain('woke 2 times (1 with a request, 1 bare')
    expect(r).toContain('looked false: 1 (50%)')
    expect(r).toContain('did not wake: 1')
    expect(r).toContain('"hey true"')
  })
})

describe('connecting the kitchen from the app', async () => {
  const { crewServer } = await import('../src/kitchen/server.js')
  const { fakeKitchen } = await import('../src/kitchen/service.js')
  it('hands out a sign-in page, then swaps in the kitchen the code connects to', async () => {
    const got: string[] = []
    const kitchen = fakeKitchen({})
    const connect = async (code: string, verifier: string, redirect: string) => { got.push(code, redirect, verifier ? 'v' : ''); return kitchen }
    const server = crewServer({ appToken: 'test-token-0123456789abcdef', canWrite: false, connect, missing: ['GREENPLATE_REFRESH_TOKEN (rejected)'] })
    await new Promise<void>((r) => server.listen(0, r))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const h = { authorization: 'Bearer test-token-0123456789abcdef' }
    const start = await (await fetch(`${base}/kitchen/connect`, { headers: h })).json() as { url: string; state: string }
    expect(start.url).toContain('resource=')
    expect(start.url).toContain(encodeURIComponent('http://127.0.0.1:8765/callback'))
    const bad = await fetch(`${base}/kitchen/connect`, { method: 'POST', headers: h, body: JSON.stringify({ code: 'c', state: 'nope' }) })
    expect(bad.status).toBe(400)
    const ok = await (await fetch(`${base}/kitchen/connect`, { method: 'POST', headers: h, body: JSON.stringify({ code: 'c1', state: start.state }) })).json()
    expect(ok.say).toBe('Your kitchen is connected.')
    expect(got).toEqual(['c1', 'http://127.0.0.1:8765/callback', 'v'])
    const health = await (await fetch(`${base}/health`)).json()
    expect(health).toMatchObject({ kitchen: true, missing: [] })
    server.close()
  })
})
