// The crew's speaking voice: ElevenLabs text to speech. Meta's Model API has no speech-output model
// (Muse Voice Transcribe is transcription only), so the voice is the one non-Meta model in the loop.
export type Speak = (text: string) => Promise<Buffer>

/** ElevenLabs bills per character; spoken answers are one or two sentences, so anything longer is cut. */
export const MAX_CHARS = 400

/** Pay for each line once: repeats ("Crew's here.", the test line, error lines) replay from memory. */
export function cachedVoice(speak: Speak, maxEntries = 200): Speak {
  const cache = new Map<string, Promise<Buffer>>()
  return (text) => {
    const key = text.trim().slice(0, MAX_CHARS)
    const hit = cache.get(key)
    if (hit) { cache.delete(key); cache.set(key, hit); return hit } // most recent last
    const audio = speak(key)
    audio.catch(() => cache.delete(key)) // a failed call is not kept, so it can be tried again
    cache.set(key, audio)
    if (cache.size > maxEntries) cache.delete(cache.keys().next().value as string)
    return audio
  }
}

export function elevenLabsVoice(opts: { apiKey?: string; voiceId?: string; model?: string; fetchImpl?: typeof fetch } = {}): Speak {
  const apiKey = opts.apiKey ?? process.env.ELEVENLABS_API_KEY
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set')
  const voiceId = opts.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb' // "George", a stock voice; replace with the chosen one
  const model = opts.model ?? process.env.ELEVENLABS_MODEL ?? 'eleven_flash_v2_5' // lowest latency
  const f = opts.fetchImpl ?? fetch
  return async (text) => {
    const r = await f(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text: text.slice(0, MAX_CHARS), model_id: model, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true } }),
    })
    if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 200)}`)
    return Buffer.from(await r.arrayBuffer())
  }
}
