import { describe, expect, it } from 'vitest'
import { limitedVoice, limiter } from '../src/kitchen/limits.js'
import { cachedVoice } from '../src/kitchen/voice.js'

describe('spending limits', () => {
  it('stops at the daily cap and resets the next day', () => {
    let t = Date.parse('2026-10-27T12:00:00Z')
    const lim = limiter({ requestsPerMinute: 100, asksPerDay: 2, framesPerDay: 1, speakCharsPerDay: 10 }, () => t)
    expect([lim.take('ask'), lim.take('ask'), lim.take('ask')]).toEqual([true, true, false])
    t = Date.parse('2026-10-28T00:00:01Z')
    expect(lim.take('ask')).toBe(true)
  })

  it('caps requests per minute', () => {
    const lim = limiter({ requestsPerMinute: 2, asksPerDay: 9, framesPerDay: 9, speakCharsPerDay: 9 }, () => 0)
    expect([lim.request(), lim.request(), lim.request()]).toEqual([true, true, false])
  })

  it('charges voice characters only for real calls, not cached repeats', async () => {
    const lim = limiter({ requestsPerMinute: 100, asksPerDay: 9, framesPerDay: 9, speakCharsPerDay: 8 }, () => 0)
    const speak = cachedVoice(limitedVoice(async (s) => Buffer.from(s), lim))
    await speak('Yes?')
    await speak('Yes?')
    await speak('Yes?')
    expect(lim.today().speakChars).toBe('4/8')
    await expect(speak('Too long here')).rejects.toThrow('daily limit')
  })
})
