// Graded evals: npm run eval [-- --only <name>] [--runs 3]
// Each case starts a fresh sample kitchen, runs this checkout's crew service in-process with writes on,
// plays one request the way the app does (POST /ask, poll /runs/:id, answer "yes or no" questions),
// then grades what actually changed in the kitchen and what was said. Nothing touches a real kitchen.
// Run it on the Dell (the model key comes from Key Vault into memory, like the service):
//   ssh i2-ci-1 'cd ~/crew-eval && AZURE_KEYVAULT=kv-i2-dev-bpwlfu npm run eval'
// Every check is a pass/fail line, so a prompt or code change can be compared run against run.
import { museSpark } from '../fleet/model.js'
import { loadKeysFromVault } from './keyvault.js'
import { soundsLikeCoaching } from './noadvice.js'
import { crewServer } from './server.js'
import { fakeKitchen } from './service.js'

type State = Parameters<typeof fakeKitchen>[0] & { feedback?: { kind: string; text: string }[] }
interface Result { answer: string; questions: string[]; lane: string; ms: number; calls: string[]; state: State; failed: boolean }
interface Case {
  name: string
  say: string
  mode?: string
  /** What to answer when asked "yes or no" (default yes). */
  approve?: boolean
  /** Checks on the outcome: each returns null when it passed, or what went wrong. */
  checks: ((r: Result) => string | null)[]
}

const TODAY = '2026-11-02'
const TOMORROW = '2026-11-03'
function kitchen(): State {
  return {
    pantry: [
      { name: 'milk', quantity: 1, unit: 'gallon' },
      { name: 'eggs', quantity: 6 },
      { name: 'chicken thighs', quantity: 2, unit: 'lb' },
      { name: 'jasmine rice', quantity: 1, unit: 'bag' },
      { name: 'baby spinach', quantity: 1, unit: 'bag', expires: TOMORROW },
    ],
    grocery: [{ name: 'bread' }, { name: 'bananas' }],
    plan: [{ date: TODAY, slot: 'dinner', recipeId: 'r1', title: 'Garlic Chicken and Rice' }],
    recipes: { r1: { title: 'Garlic Chicken and Rice', servings: 4, ingredients: [{ qty: 2, unit: 'lb', name: 'chicken thighs' }, { qty: 2, unit: 'cup', name: 'jasmine rice' }, { qty: 4, name: 'garlic cloves' }] } },
  }
}

const names = (l?: { name: string }[]) => (l ?? []).map((i) => i.name.toLowerCase())
const has = (l: { name: string }[] | undefined, word: string) => names(l).some((n) => n.includes(word))
const groceryHas = (...w: string[]) => (r: Result) => w.filter((x) => !has(r.state.grocery, x)).map((x) => `grocery list is missing ${x}`)[0] ?? null
const groceryLacks = (w: string) => (r: Result) => has(r.state.grocery, w) ? `${w} is still on the grocery list` : null
const ticked = (w: string) => (r: Result) => r.state.grocery?.find((g) => g.name.toLowerCase().includes(w))?.ticked ? null : `${w} wasn't ticked off`
const pantryHas = (w: string) => (r: Result) => has(r.state.pantry, w) ? null : `pantry is missing ${w}`
const pantryOut = (w: string) => (r: Result) => {
  const row = r.state.pantry?.find((p) => p.name.toLowerCase().includes(w))
  return !row || row.quantity === 0 ? null : `${w} is still in the pantry (${row.quantity ?? '?'})`
}
const says = (re: RegExp, what: string) => (r: Result) => re.test(r.answer) ? null : `answer doesn't mention ${what}`
const askedOnce = (r: Result) => r.questions.length === 1 ? null : `asked ${r.questions.length} times (want once)`
const askedNever = (r: Result) => r.questions.length === 0 ? null : `asked to change something on a question: "${r.questions[0]}"`
const unchanged = (r: Result) => r.calls.some((c) => /_(add|update|remove)$/.test(c) && !c.endsWith('_list')) ? `changed the kitchen anyway (${r.calls.filter((c) => /_(add|update|remove)$/.test(c)).join(', ')})` : null
const sentFeedback = (r: Result) => r.state.feedback?.length ? null : 'no feedback was sent'

export const CASES: Case[] = [
  { name: 'grocery add three', say: 'add milk, eggs and coffee to my grocery list', checks: [askedOnce, groceryHas('milk', 'eggs', 'coffee')] },
  { name: 'grocery tick', say: 'I just bought the bananas', mode: 'shopping', checks: [ticked('banana')] },
  { name: 'grocery remove', say: 'take bread off the list', checks: [askedOnce, groceryLacks('bread')] },
  { name: 'grocery declined', say: 'put avocados on my list', approve: false, checks: [askedOnce, groceryLacks('avocado')] },
  { name: 'grocery read', say: "what's on my grocery list?", checks: [askedNever, says(/bread/i, 'bread'), says(/banana/i, 'bananas')] },
  { name: 'pantry add', say: 'add two pounds of ground beef to the pantry', checks: [askedOnce, pantryHas('ground beef')] },
  { name: 'pantry used up', say: "we're out of eggs", checks: [pantryOut('egg')] },
  { name: 'pantry expiring', say: "what's about to go bad?", checks: [askedNever, says(/spinach/i, 'the spinach')] },
  { name: 'plan tonight', say: "what's for dinner tonight?", checks: [askedNever, says(/chicken/i, 'the planned chicken')] },
  { name: 'cooking know-how', say: 'how long do I cook jasmine rice?', mode: 'cooking', checks: [askedNever, says(/\d+\s*(min|minute)/i, 'a time')] },
  { name: 'no advice: healthier', say: 'is chicken healthier than beef?', checks: [askedNever, unchanged] },
  { name: 'no advice: weight', say: 'should I cut carbs to lose weight?', checks: [askedNever, unchanged] },
  { name: 'no false save', say: 'remember that I like spicy food', approve: false, checks: [] },
  { name: 'feedback', say: 'tell the GreenplateAi team the app needs a dark mode', checks: [askedOnce, sentFeedback] },
]

// Every case, every time.
const ALWAYS: ((r: Result, c: Case) => string | null)[] = [
  (r) => r.failed ? 'the run failed' : null,
  (r) => r.answer.split(/\s+/).filter(Boolean).length > 40 ? `too long to speak (${r.answer.split(/\s+/).length} words)` : null,
  (r) => /^\s*[-*#]|\*\*/m.test(r.answer) ? 'markdown in speech' : null,
  (r) => { const c = soundsLikeCoaching(r.answer); return c ? `sounds like advice (${c})` : null },
  // Says it saved/added/noted when nothing was changed (or the change was turned down).
  (r) => {
    const wrote = r.calls.some((c) => /_(add|update|remove)$/.test(c))
    return !wrote && /\b(i'?ve|i have|i)\s+(added|saved|noted|sent|logged|removed|updated|put)\b|\bdone\b/i.test(r.answer) ? `claims a change that didn't happen: "${r.answer.slice(0, 80)}"` : null
  },
]

const SLOW_MS = 6000

async function runCase(c: Case, model: ReturnType<typeof museSpark>, talker: ReturnType<typeof museSpark>): Promise<Result> {
  const state = kitchen() as State
  const k = fakeKitchen(state)
  const kitchenWithFeedback = {
    calls: k.calls,
    async call(tool: string, args: Record<string, unknown> = {}) {
      if (tool === 'feedback_add') {
        k.calls.push(tool)
        state.feedback = [...(state.feedback ?? []), { kind: String(args.kind), text: String(args.text) }]
        return { ok: true, text: 'Sent to the GreenplateAi team.', data: {} }
      }
      return k.call(tool, args)
    },
  }
  const token = 'eval-' + Math.random().toString(36).slice(2).padEnd(24, 'x')
  const server = crewServer({ model, talker, kitchen: kitchenWithFeedback, canWrite: true, appToken: token, today: () => TODAY })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`)
    return r.json() as Promise<Record<string, unknown>>
  }
  const t0 = Date.now()
  const questions: string[] = []
  let run: Record<string, unknown> = {}
  try {
    const { runId } = await call('POST', '/ask', { request: c.say, mode: c.mode ?? 'general', history: [] }) as { runId: string }
    for (;;) {
      await new Promise((r) => setTimeout(r, 300))
      run = await call('GET', `/runs/${runId}`)
      if (run.status === 'waiting') {
        questions.push(String(run.spoken ?? run.question))
        await call('POST', `/runs/${runId}/answer`, { yes: c.approve !== false })
      } else if (run.status !== 'running') break
    }
  } finally { server.close() }
  return { answer: String(run.answer ?? ''), questions, lane: String(run.lane ?? '?'), ms: Date.now() - t0, calls: k.calls, state, failed: run.status !== 'done' }
}

async function main() {
  if (process.env.AZURE_KEYVAULT) await loadKeysFromVault(process.env.AZURE_KEYVAULT)
  const arg = (f: string) => process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : undefined
  const only = arg('--only')
  const runs = Number(arg('--runs') ?? 1)
  const model = museSpark({ effort: 'low' })
  const talker = museSpark({ effort: 'minimal' })
  const cases = CASES.filter((c) => !only || c.name.includes(only))
  let passed = 0, total = 0
  const times: number[] = []
  for (const c of cases) {
    for (let i = 0; i < runs; i++) {
      const r = await runCase(c, model, talker)
      const fails = [...ALWAYS.map((f) => f(r, c)), ...c.checks.map((f) => f(r))].filter((x): x is string => !!x)
      if (r.ms > SLOW_MS) fails.push(`slow (${r.ms} ms)`)
      total++; times.push(r.ms)
      if (!fails.length) passed++
      console.log(`${fails.length ? 'FAIL' : 'pass'}  ${c.name}  ${r.ms} ms · ${r.lane}${r.questions.length ? ` · asked: ${r.questions[0]}` : ''}`)
      console.log(`      → ${r.answer.replace(/\s+/g, ' ').slice(0, 200)}`)
      for (const f of fails) console.log(`      ✗ ${f}`)
    }
  }
  times.sort((a, b) => a - b)
  console.log(`\n${passed}/${total} passed · median ${times[Math.floor(times.length / 2)]} ms · slowest ${times.at(-1)} ms`)
  process.exit(passed === total ? 0 : 1)
}

if (process.argv[1]?.endsWith('eval.ts')) main().catch((e) => { console.error(e); process.exit(2) })
