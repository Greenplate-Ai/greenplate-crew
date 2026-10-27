import { describe, expect, it } from 'vitest'
import { elevenLabsVoice } from '../src/kitchen/voice.js'

describe('ElevenLabs voice', () => {
  it('posts the text to the chosen voice and returns the audio bytes', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }) as unknown as typeof fetch
    const speak = elevenLabsVoice({ apiKey: 'k', voiceId: 'v1', fetchImpl: fakeFetch })
    const audio = await speak('Green onions, checked off.')
    expect([...audio]).toEqual([1, 2, 3])
    expect(seen?.url).toContain('/v1/text-to-speech/v1?output_format=mp3_44100_128')
    expect((seen?.init.headers as Record<string, string>)['xi-api-key']).toBe('k')
    expect(JSON.parse(String(seen?.init.body)).text).toBe('Green onions, checked off.')
  })

  it('reports an ElevenLabs error instead of returning silence', async () => {
    const fakeFetch = (async () => new Response('quota', { status: 401 })) as unknown as typeof fetch
    await expect(elevenLabsVoice({ apiKey: 'k', fetchImpl: fakeFetch })('hi')).rejects.toThrow('ElevenLabs 401')
  })
})
