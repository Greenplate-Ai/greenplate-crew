import { describe, expect, it } from 'vitest'
import { askCrew } from '../src/kitchen/crew.js'
import { fakeKitchen } from '../src/kitchen/service.js'
import { say, scripted } from '../src/fleet/model.js'
import { soundsLikeCoaching } from '../src/kitchen/noadvice.js'

describe('no-advice guard', () => {
  it('flags coaching and health talk', () => {
    for (const s of ['You should eat more protein tonight.', 'That pasta is unhealthy.', 'Cut back on sugar this week.', 'Good for losing weight.', 'Ask your doctor about it.', 'A great choice for your health.'])
      expect(soundsLikeCoaching(s), s).not.toBeNull()
  })

  it('lets kitchen facts through', () => {
    for (const s of ['I moved Tuesday’s dinner to Thursday.', 'You need green onions and soy sauce.', 'Logged lunch: rice and chicken, estimated.', 'The spinach goes off Wednesday, so it is in tonight’s dinner.'])
      expect(soundsLikeCoaching(s), s).toBeNull()
  })

  const base = { kitchen: fakeKitchen({}), canWrite: true, budget: { maxTurns: 4, maxServiceCalls: 10, maxUsd: 1 }, confirm: async () => true, today: '2026-10-26' }

  it('rewrites a coaching answer as kitchen facts', async () => {
    const model = scripted([say('You should eat less rice tonight.'), say('Tonight is chicken and rice.')])
    const r = await askCrew("what's for dinner?", 'general', { ...base, model })
    expect(r.answer).toBe('Tonight is chicken and rice.')
    expect(r.log.steps.some((s) => s.note?.startsWith('answer guard'))).toBe(true)
  })

  it('falls back to a neutral answer if the rewrite still coaches', async () => {
    const model = scripted([say('That meal is unhealthy.'), say('Try a healthier option.')])
    const r = await askCrew("what's for dinner?", 'general', { ...base, model })
    expect(r.answer).toBe('Done. Check the app for the details.')
  })
})
