// Ask the crew from a terminal: npm run ask -- shopping "I'm at the store, what am I missing?"
import { askCrew, type Mode } from './crew.js'
import { connectKitchen } from './service.js'
import { museSpark } from '../fleet/model.js'

const [modeArg, ...words] = process.argv.slice(2)
const mode = (modeArg ?? 'general') as Mode
const request = words.join(' ') || 'What am I missing for this week?'

const kitchen = await connectKitchen()
try {
  const result = await askCrew(request, mode, {
    model: museSpark(),
    kitchen,
    canWrite: process.env.CREW_CAN_WRITE === '1',
    budget: { maxTurns: 6, maxServiceCalls: 40, maxUsd: 0.25 },
    confirm: async (q) => { console.log(`(would ask) ${q}`); return false },
    today: new Date().toISOString().slice(0, 10),
  })
  console.log(`\n${result.answer}\n`)
  console.log(result.log.lines().join('\n'))
  console.log(`\nstopped: ${result.stoppedBecause} · kitchen calls: ${result.log.serviceCalls} · $${result.log.usd.toFixed(4)}`)
} finally {
  await kitchen.close()
}
