import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { crewServer } from '../src/kitchen/server.js'
import { fakeKitchen } from '../src/kitchen/service.js'
import { barcodeLookup, inPantry, shortName } from '../src/kitchen/takeout.js'

const TOKEN = 'test-token-0123456789abcdef'

async function start() {
  const kitchen = fakeKitchen({ pantry: [{ name: 'Natures Own Keto Burger Buns' }, { name: 'Large eggs' }] } as never)
  let photos = 0
  const eyes = async () => { photos++; return { item: 'bell pepper', confidence: 0.9 } }
  const lookup = async (code: string) => (code === '0072250037129' ? "Nature's Own keto burger buns" : null)
  const server = crewServer({ appToken: TOKEN, canWrite: false, kitchen, eyes, lookup, model: {} as never })
  await new Promise<void>((r) => server.listen(0, r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = async (path: string, body: unknown = {}) =>
    (await fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>
  return { post, kitchen, photos: () => photos, close: () => server.close() }
}

describe('kitchen mode', () => {
  it('names each item once, by barcode for free or by photo, and writes nothing', async () => {
    const { post, kitchen, photos, close } = await start()
    const { sessionId } = await post('/kitchen/start')
    const first = await post(`/kitchen/${sessionId}/item`, { barcode: '0072250037129' })
    expect(first.say).toBe("Got Nature's Own keto burger buns.")
    const again = await post(`/kitchen/${sessionId}/item`, { barcode: '0072250037129' })
    expect(again.say).toBeNull()
    expect(photos()).toBe(0)
    const unknown = await post(`/kitchen/${sessionId}/item`, { barcode: '999999' })
    expect(unknown).toMatchObject({ item: null, unknownBarcode: true, say: null })
    const pepper = await post(`/kitchen/${sessionId}/item`, { jpegBase64: 'x' })
    expect(pepper.say).toBe('Got bell pepper.')
    expect(photos()).toBe(1)
    const end = await post(`/kitchen/${sessionId}/end`)
    expect(end.say).toBe("You pulled out Nature's Own keto burger buns and bell pepper. Not on your pantry list yet: bell pepper.")
    expect(kitchen.calls.filter((c) => c !== 'kitchen_pantry_list')).toEqual([])
    close()
  })

  it('tidies product names and matches them to the pantry', () => {
    expect(shortName('Keto Burger Buns 8 ct', "Nature's Own")).toBe("Nature's Own Keto Burger Buns")
    expect(inPantry("Nature's Own keto burger buns", ['Natures Own Keto Burger Buns'])).toBe('Natures Own Keto Burger Buns')
    expect(inPantry('bell pepper', ['Large eggs'])).toBeUndefined()
  })

  it('only looks up real barcodes and retries ones it could not find', async () => {
    let calls = 0
    const f = (async () => { calls++; return new Response(JSON.stringify({ product: {} })) }) as typeof fetch
    const lookup = barcodeLookup(f)
    expect(await lookup('abc')).toBeNull()
    expect(await lookup('0123456789')).toBeNull()
    expect(await lookup('0123456789')).toBeNull()
    expect(calls).toBe(2)
  })
})
