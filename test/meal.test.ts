import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { crewServer } from '../src/kitchen/server.js'
import { fakeKitchen } from '../src/kitchen/service.js'
import { plateItems, spokenList } from '../src/kitchen/vision.js'

const TOKEN = 'test-token-0123456789abcdef'

async function start(canWrite: boolean, limitAfter?: number) {
  const kitchen = fakeKitchen({ limitAfter })
  const plate = async () => [{ name: 'grilled chicken', portion: '1 breast' }, { name: 'white rice' }]
  const server = crewServer({ appToken: TOKEN, canWrite, kitchen, plate, today: () => '2026-10-28' })
  await new Promise<void>((r) => server.listen(0, r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = async (path: string, body: unknown) =>
    (await fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>
  return { post, kitchen, close: () => server.close() }
}

describe('logging a meal from a photo', () => {
  it('reads the model output into clean items', () => {
    expect(plateItems('{"items":[{"name":" rice ","portion":null},{"name":""},{"portion":"x"}]}')).toEqual([{ name: 'rice' }])
    expect(plateItems('not json')).toEqual([])
    expect(spokenList(['chicken', 'rice', 'broccoli'])).toBe('chicken, rice and broccoli')
  })

  it('asks before logging and logs nothing on a no', async () => {
    const { post, kitchen, close } = await start(true)
    const seen = await post('/meal/photo', { jpegBase64: 'x', slot: 'dinner', date: '2026-10-28' })
    expect(seen.say).toBe('I see grilled chicken and white rice. Log that as dinner?')
    const no = await post(`/meal/${seen.mealId}/log`, { yes: false })
    expect(no.logged).toBe(false)
    expect(kitchen.calls).toEqual([])
    close()
  })

  it('says logging is off when writes are off', async () => {
    const { post, kitchen, close } = await start(false)
    const seen = await post('/meal/photo', { jpegBase64: 'x', slot: 'lunch' })
    const r = await post(`/meal/${seen.mealId}/log`, { yes: true })
    expect(r).toEqual({ logged: false, say: "Logging is switched off for now, so I didn't save it." })
    expect(kitchen.calls).toEqual([])
    close()
  })

  it('says when the plan does not include logging', async () => {
    const { post, close } = await start(true, 0)
    const seen = await post('/meal/photo', { jpegBase64: 'x', slot: 'lunch' })
    const r = await post(`/meal/${seen.mealId}/log`, { yes: true })
    expect(r.logged).toBe(false)
    expect(String(r.say)).toContain('GreenplateAi Plus')
    close()
  })
})
