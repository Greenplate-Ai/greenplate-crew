// Conversation simulator: npm run sim [-- --voice] [--only <name>]
// Plays scripted multi-turn kitchen conversations through the running crew service exactly the way
// the app does (POST /ask with the chat so far, poll /runs/:id every 400 ms) and scores each turn
// against how people expect a spoken assistant to behave: quick, short, and remembers what was said.
// Run it on the Dell (it reads the app token from Key Vault into memory, like the service does):
//   ssh i2-ci-1 'cd ~/greenplate-crew && AZURE_KEYVAULT=kv-i2-dev-bpwlfu npm run sim'
// Each turn uses one of the day's asks (150/day cap). --voice also times /speak (costs TTS characters).
import { loadKeysFromVault } from './keyvault.js'

interface Turn { say: string; expect?: RegExp } // expect: the answer should show it kept the context
interface Convo { name: string; mode?: string; turns: Turn[] }

export const CONVOS: Convo[] = [
  { name: 'pantry follow-up', turns: [
    { say: "what's in my pantry?" },
    { say: 'anything I could make with that?', expect: /bun|burger|sandwich/i },
    { say: 'okay what else would I need for that?' },
  ] },
  { name: 'plan this week', turns: [
    { say: "what's on my meal plan this week?" },
    { say: 'what about tomorrow?' },
    { say: 'and do I have what I need for it?' },
  ] },
  { name: 'quick cooking', mode: 'cooking', turns: [
    { say: 'how long do I bake chicken thighs at 400?' },
    { say: 'and if they have the bone in?', expect: /bone|longer|minute/i },
    { say: 'how do I know they are done?', expect: /165|temperature|thermometer|juice/i },
  ] },
  { name: 'small talk then kitchen', turns: [
    { say: 'hey how is it going' },
    { say: 'what should I have for dinner tonight?' },
    { say: 'something lighter', expect: /salad|light|soup|fish|veg|chicken/i },
  ] },
  { name: 'pronoun carry', turns: [
    { say: 'do I have any eggs?' },
    { say: 'how many would I need for an omelette?', expect: /egg|two|three|2|3/i },
    { say: 'add them to my list' },
  ] },
  { name: 'one-shot', turns: [
    { say: 'whats a good high protein snack' },
  ] },
]

const SLOW_MS = 4000 // past this, people assume it didn't hear them (the app speaks a filler at 2.5 s)
const MAX_WORDS = 40 // about 12 seconds of speech; longer answers belong on screen

const words = (s: string) => s.split(/\s+/).filter(Boolean).length
const sentences = (s: string) => s.split(/[.!?]+\s/).filter((x) => x.trim()).length

async function main() {
  if (process.env.AZURE_KEYVAULT) await loadKeysFromVault(process.env.AZURE_KEYVAULT)
  const token = process.env.CREW_APP_TOKEN
  if (!token) throw new Error('No CREW_APP_TOKEN (run on the Dell with AZURE_KEYVAULT set)')
  const base = process.env.CREW_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`
  const voice = process.argv.includes('--voice')
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`)
    return r
  }

  const rows: { convo: string; say: string; ms: number; lane: string; words: number; flags: string[]; answer: string }[] = []
  for (const c of CONVOS.filter((c) => !only || c.name === only)) {
    const history: { who: string; text: string }[] = []
    for (const t of c.turns) {
      const t0 = Date.now()
      const { runId } = await (await call('POST', '/ask', { request: t.say, mode: c.mode ?? 'general', history: history.slice(-10) })).json() as { runId: string }
      let run: { status: string; answer?: string; lane?: string }
      for (;;) {
        await new Promise((r) => setTimeout(r, 400))
        run = await (await call('GET', `/runs/${runId}`)).json() as typeof run
        if (run.status === 'waiting') await call('POST', `/runs/${runId}/answer`, { yes: false }) // never approve changes
        else if (run.status !== 'running') break
      }
      const ms = Date.now() - t0
      const answer = run.answer ?? ''
      const flags: string[] = []
      if (run.status === 'failed') flags.push('failed')
      if (ms > SLOW_MS) flags.push('slow')
      if (words(answer) > MAX_WORDS) flags.push(`long (${sentences(answer)} sentences)`)
      if (t.expect && !t.expect.test(answer)) flags.push('lost the thread')
      if (/^\s*[-*#]|\*\*/m.test(answer)) flags.push('markdown in speech')
      let speakMs: number | undefined
      if (voice && answer) { const s0 = Date.now(); await call('POST', '/speak', { text: answer }); speakMs = Date.now() - s0 }
      rows.push({ convo: c.name, say: t.say, ms, lane: run.lane ?? '?', words: words(answer), flags: speakMs ? [...flags, `voice ${speakMs} ms`] : flags, answer })
      history.push({ who: 'me', text: t.say }, { who: 'crew', text: answer })
    }
  }

  const sorted = rows.map((r) => r.ms).sort((a, b) => a - b)
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  const count = (f: (r: typeof rows[number]) => boolean) => rows.filter(f).length
  console.log(`\n${rows.length} turns · median ${pct(0.5)} ms · p90 ${pct(0.9)} ms · slow ${count((r) => r.flags.includes('slow'))} · long ${count((r) => r.flags.some((f) => f.startsWith('long')))} · lost thread ${count((r) => r.flags.includes('lost the thread'))} · quick lane ${count((r) => r.lane === 'quick')}/${rows.length}\n`)
  for (const r of rows) {
    console.log(`[${r.convo}] "${r.say}"  ${r.ms} ms · ${r.lane} · ${r.words} words${r.flags.length ? ' · ' + r.flags.join(', ') : ''}`)
    console.log(`   → ${r.answer.replace(/\s+/g, ' ').slice(0, 220)}`)
  }
}

main().catch((e) => { console.error(e.message); process.exit(1) })
