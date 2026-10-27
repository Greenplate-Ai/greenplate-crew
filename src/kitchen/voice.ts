// The crew's speaking voice: ElevenLabs text to speech. Meta's Model API has no speech-output model
// (Muse Voice Transcribe is transcription only), so the voice is the one non-Meta model in the loop.
export type Speak = (text: string) => Promise<Buffer>

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
      body: JSON.stringify({ text: text.slice(0, 1000), model_id: model, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true } }),
    })
    if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 200)}`)
    return Buffer.from(await r.arrayBuffer())
  }
}
