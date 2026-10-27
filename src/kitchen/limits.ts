// Spending guard for the crew service: hard caps on what can reach the paid APIs (Meta for /ask and
// shopping frames, ElevenLabs for /speak), whatever the app or anyone holding the token does.
// Counters live in memory and reset at midnight UTC; over a cap the service answers 429.
export const LIMITS = {
  requestsPerMinute: 60, // every request, before the token is checked
  asksPerDay: 150, // Muse Spark runs (each run is itself capped at 6 turns / $0.25)
  framesPerDay: 300, // Muse Spark vision calls during shopping trips
  speakCharsPerDay: 8000, // ElevenLabs characters actually sent (cached repeats are free)
}

export type Kind = 'ask' | 'frame' | 'speakChars'

export function limiter(limits = LIMITS, now: () => number = Date.now) {
  let day = ''
  const used: Record<Kind, number> = { ask: 0, frame: 0, speakChars: 0 }
  const cap: Record<Kind, number> = { ask: limits.asksPerDay, frame: limits.framesPerDay, speakChars: limits.speakCharsPerDay }
  let minute = 0
  let thisMinute = 0
  const rollDay = () => {
    const d = new Date(now()).toISOString().slice(0, 10)
    if (d !== day) { day = d; used.ask = used.frame = used.speakChars = 0 }
  }
  return {
    /** False when this minute already had too many requests. */
    request(): boolean {
      const m = Math.floor(now() / 60_000)
      if (m !== minute) { minute = m; thisMinute = 0 }
      return ++thisMinute <= limits.requestsPerMinute
    },
    /** Takes `amount` from today's allowance; false (and nothing taken) if it would go over. */
    take(kind: Kind, amount = 1): boolean {
      rollDay()
      if (used[kind] + amount > cap[kind]) return false
      used[kind] += amount
      return true
    },
    /** Gives back an allowance that wasn't spent (e.g. a line served from the cache). */
    refund(kind: Kind, amount = 1): void { used[kind] = Math.max(0, used[kind] - amount) },
    today(): Record<Kind, string> {
      rollDay()
      return { ask: `${used.ask}/${cap.ask}`, frame: `${used.frame}/${cap.frame}`, speakChars: `${used.speakChars}/${cap.speakChars}` }
    },
  }
}

export class OverLimit extends Error {
  constructor(what: string) { super(`daily limit reached: ${what}`) }
}

/** Charges each real ElevenLabs call against the daily character cap. Put it inside cachedVoice so repeats cost nothing. */
export function limitedVoice(speak: (text: string) => Promise<Buffer>, lim: ReturnType<typeof limiter>) {
  return async (text: string) => {
    if (!lim.take('speakChars', text.length)) throw new OverLimit('voice characters')
    try { return await speak(text) } catch (e) { lim.refund('speakChars', text.length); throw e }
  }
}
