// The crew service the glasses app talks to. Plain Node http, no framework.
//   POST /ask            {request, mode}            -> {runId}
//   GET  /runs/:id                                  -> {status, answer?, question?, spoken?, steps}
//   POST /runs/:id/answer {yes}                     -> {ok}
//   POST /shopping/start {from, to}                 -> {tripId, needs}
//   POST /shopping/:id/frame {jpegBase64}           -> {say?}
//   POST /shopping/:id/checkout                     -> {say}
//   POST /kitchen/start                              -> {sessionId}          (kitchen mode: food coming out)
//   POST /kitchen/:id/item {barcode? | jpegBase64?}  -> {item?, say?}        (say is null when already counted)
//   POST /kitchen/:id/end                            -> {items, say}
//   POST /meal/photo {jpegBase64, date, slot}   -> {mealId?, items, say}   (nothing saved yet)
//   POST /meal/:id/log {yes}                    -> {logged, say}
//   POST /events {kind, ms?, detail?}               -> {ok}   (the app's own timings, for npm run report)
//   POST /speak          {text}                     -> audio/mpeg (404 when no voice is configured)
// Auth: every request needs "Authorization: Bearer <CREW_APP_TOKEN>".
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Model } from '../fleet/model.js'
import type { RunLog } from '../fleet/runlog.js'
import { askCrew, type Mode } from './crew.js'
import type { Kitchen } from './service.js'
import { REWRITE, soundsLikeCoaching } from './noadvice.js'
import { buildShoppingList } from './shopping.js'
import { limiter, OverLimit } from './limits.js'
import { spokenQuestion } from './speak.js'
import { MAX_CHARS, type Speak } from './voice.js'
import { barcodeLookup, summary, takeOut, type Session } from './takeout.js'
import { noticeItem, remaining, spokenList, type PlateItem, type Seen, type ShoppingTrip } from './vision.js'

interface RunState {
  status: 'running' | 'waiting' | 'done' | 'failed'
  answer?: string
  question?: string
  resolve?: (yes: boolean) => void
  log?: RunLog
  stoppedBecause?: string
  lane?: string // which path answered: quick (one call), crew (agents), talk (no kitchen)
  ms?: number
}

export interface ServerDeps {
  /** Missing pieces leave the service up: /health and /speak still work, the rest answer 503 naming what's missing. */
  model?: Model
  /** A quicker model for plain conversation (no kitchen tools); falls back to `model`. */
  talker?: Model
  kitchen?: Kitchen
  eyes?: (jpegBase64: string) => Promise<Seen>
  /** Names the foods on the plate, for logging a meal from a photo. */
  plate?: (jpegBase64: string) => Promise<PlateItem[]>
  missing?: string[]
  speak?: Speak
  canWrite: boolean
  appToken: string
  today?: () => string
  /** Spending caps; a fresh default limiter when not given. */
  limits?: ReturnType<typeof limiter>
  /** Barcode -> product name; Open Food Facts when not given. */
  lookup?: (code: string) => Promise<string | null>
}

const MODES: Mode[] = ['shopping', 'capture', 'cooking', 'eating_out', 'pantry_check', 'general']

export function crewServer(d: ServerDeps) {
  const runs = new Map<string, RunState>()
  const trips = new Map<string, ShoppingTrip>()
  const meals = new Map<string, { items: PlateItem[]; date: string; slot: string; at: number }>()
  const today = d.today ?? (() => new Date().toISOString().slice(0, 10))
  const lim = d.limits ?? limiter()
  const snapshot = kitchenSnapshot()
  const sessions = new Map<string, Session>()
  const lookup = d.lookup ?? barcodeLookup()

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The app checking on a run it already started (GET /runs/:id) isn't new work, so it isn't counted.
    const polling = req.method === 'GET' && (req.url ?? '').startsWith('/runs/')
    if (!polling && !lim.request()) return send(res, 429, { error: 'too many requests, slow down' })
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, voice: !!d.speak, talk: !!d.model, crew: !!(d.model && d.kitchen), missing: d.missing ?? [], usedToday: lim.today() })
    }
    if (req.headers.authorization !== `Bearer ${d.appToken}`) return send(res, 401, { error: 'unauthorized' })
    const url = new URL(req.url ?? '/', 'http://crew')
    const parts = url.pathname.split('/').filter(Boolean)

    // Talking (/ask, /runs) needs only the model; with no kitchen yet the crew just talks, no kitchen tools.
    const needsModel = (req.method === 'POST' && url.pathname === '/ask') || parts[0] === 'runs'
    const needsCrew = req.method === 'POST' && (parts[0] === 'shopping' || parts[0] === 'kitchen')
    if ((needsModel && !d.model) || (needsCrew && !(d.model && d.kitchen))) {
      return send(res, 503, { error: 'the crew is not set up yet', missing: d.missing ?? [] })
    }
    const model = d.model as Model
    const kitchen = d.kitchen as Kitchen

    if (req.method === 'POST' && url.pathname === '/ask') {
      const body = await json(req)
      const request = String(body.request ?? '').slice(0, 500)
      const mode = (MODES.includes(body.mode as Mode) ? body.mode : 'general') as Mode
      if (!request) return send(res, 400, { error: 'request is required' })
      const history = chatHistory(body.history)
      if (!lim.take('ask')) return send(res, 429, { error: 'the crew has hit its daily limit' })
      const id = randomUUID()
      const run: RunState = { status: 'running' }
      runs.set(id, run)
      // The crew gets the last few lines too, so "add them to my list" knows what "them" is.
      const recent = history.slice(-6).map((h) => `${h.role === 'user' ? 'Person' : 'Crew'}: ${h.content}`).join('\n')
      const crew = () => askCrew(recent ? `Conversation so far:\n${recent}\n\nNow the person says: ${request}` : request, mode, {
        model, kitchen, canWrite: d.canWrite, today: today(),
        budget: { maxTurns: 6, maxServiceCalls: 40, maxUsd: 0.25 },
        confirm: (question) => new Promise<boolean>((resolve) => { run.status = 'waiting'; run.question = question; run.resolve = resolve }),
      }, id)
      // Fast lane: most questions are answered in one quick model call over a snapshot of the
      // kitchen; only real jobs (changes, shopping lists, recipes) go to the full crew.
      let lane = d.kitchen ? 'crew' : 'talk'
      const work = !d.kitchen ? talkOnly(d.talker ?? model, request, history)
        : d.talker && QUICK_MODES.includes(mode)
          ? quickAnswer(d.talker, () => snapshot.get(kitchen, today()), request, history).then((r) => r ? (lane = 'quick', r) : crew())
          : crew()
      const started = Date.now()
      work.then((r) => {
        // Start the voice now, so the app's /speak for this answer finds it ready (or in flight) in the cache.
        if (d.speak && r.answer) d.speak(r.answer).catch(() => {})
        Object.assign(run, { status: 'done', answer: r.answer, log: r.log, stoppedBecause: r.stoppedBecause, question: undefined, resolve: undefined, lane, ms: Date.now() - started })
        if (lane === 'crew') snapshot.clear() // the crew may have changed the kitchen
        console.log(`ask answered in ${Date.now() - started} ms (${lane}, ${history.length} lines of history)`)
      }).catch((e: Error) => { Object.assign(run, { status: 'failed', answer: `Something went wrong: ${e.message}` }) })
      return send(res, 202, { runId: id })
    }

    if (parts[0] === 'runs' && parts[1]) {
      const run = runs.get(parts[1])
      if (!run) return send(res, 404, { error: 'no such run' })
      if (req.method === 'GET' && parts.length === 2) {
        return send(res, 200, { status: run.status, answer: run.answer, question: run.question, spoken: run.question ? spokenQuestion(run.question) : undefined, stoppedBecause: run.stoppedBecause, lane: run.lane, ms: run.ms, steps: run.log?.lines() ?? [], usd: run.log?.usd ?? 0 })
      }
      if (req.method === 'POST' && parts[2] === 'answer') {
        const body = await json(req)
        if (run.status !== 'waiting' || !run.resolve) return send(res, 409, { error: 'nothing to answer' })
        const resolve = run.resolve
        Object.assign(run, { status: 'running', question: undefined, resolve: undefined })
        resolve(body.yes === true)
        return send(res, 200, { ok: true })
      }
    }

    if (req.method === 'POST' && url.pathname === '/shopping/start') {
      const body = await json(req)
      const from = String(body.from ?? today())
      const to = String(body.to ?? from)
      const list = await buildShoppingList(kitchen, from, to)
      const pantry = await kitchen.call('kitchen_pantry_list')
      const names = ((pantry.data as { items?: { name: string }[] })?.items ?? []).map((p) => p.name)
      const id = randomUUID()
      trips.set(id, { list, pantry: names, checked: new Set(), announced: new Set() })
      return send(res, 200, { tripId: id, needs: list.needs.map((n) => n.name), unknownRecipes: list.unknownRecipes })
    }

    if (req.method === 'POST' && parts[0] === 'kitchen') {
      if (parts[1] === 'start') {
        const pantry = await kitchen.call('kitchen_pantry_list')
        const names = ((pantry.data as { items?: { name: string }[] })?.items ?? []).map((p) => p.name)
        for (const [k, s] of sessions) if (Date.now() - s.at > 3 * 3_600_000) sessions.delete(k)
        const id = randomUUID()
        sessions.set(id, { items: [], seen: new Set(), pantry: names, at: Date.now() })
        return send(res, 200, { sessionId: id })
      }
      const s = sessions.get(parts[1] ?? '')
      if (!s) return send(res, 404, { error: 'no such kitchen session' })
      if (parts[2] === 'item') {
        const body = await json(req, 4_000_000)
        let item: string | null = null
        if (body.barcode) item = await lookup(String(body.barcode))
        else if (body.jpegBase64 && d.eyes) {
          if (!lim.take('frame')) return send(res, 429, { error: 'the crew has hit its daily limit' })
          const seen = await d.eyes(String(body.jpegBase64)) // the photo is not kept after this call
          item = seen.item && seen.confidence >= 0.5 ? seen.item : null
        }
        if (!item) return send(res, 200, { item: null, unknownBarcode: !!body.barcode, say: body.barcode ? null : "I couldn't tell what that is. Hold it up a bit closer." })
        return send(res, 200, { item, say: takeOut(s, item) })
      }
      if (parts[2] === 'end') {
        sessions.delete(parts[1]!)
        return send(res, 200, { items: s.items, say: summary(s) })
      }
    }

    if (req.method === 'POST' && url.pathname === '/events') {
      const body = await json(req)
      const kind = String(body.kind ?? '').replace(/[^a-z_]/g, '').slice(0, 32)
      if (!kind) return send(res, 400, { error: 'kind is required' })
      const ms = Number.isFinite(Number(body.ms)) ? ` ${Math.round(Number(body.ms))} ms` : ''
      const detail = String(body.detail ?? '').replace(/\s+/g, ' ').slice(0, 120)
      console.log(`app ${kind}${ms}${detail ? ` (${detail})` : ''}`)
      return send(res, 200, { ok: true })
    }

    if (req.method === 'POST' && url.pathname === '/speak') {
      if (!d.speak) return send(res, 404, { error: 'no voice configured' })
      const body = await json(req)
      const text = String(body.text ?? '').trim().slice(0, MAX_CHARS)
      if (!text) return send(res, 400, { error: 'text is required' })
      const t0 = Date.now()
      const audio = await d.speak(text)
      console.log(`speak ${text.length} chars -> ${audio.length} bytes in ${Date.now() - t0} ms`)
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length })
      res.end(audio)
      return
    }

    // Log a meal from a photo: name what's on the plate, ask, then log only on a yes.
    if (parts[0] === 'meal' && req.method === 'POST') {
      if (parts[1] === 'photo') {
        if (!d.plate) return send(res, 503, { error: 'vision is not set up yet', missing: d.missing ?? [] })
        if (!d.kitchen) return send(res, 503, { error: 'the kitchen is not connected yet', missing: d.missing ?? [] })
        const body = await json(req, 4_000_000)
        const jpeg = String(body.jpegBase64 ?? '')
        if (!jpeg) return send(res, 400, { error: 'jpegBase64 is required' })
        const slot = SLOTS.includes(String(body.slot)) ? String(body.slot) : 'snack'
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date)) ? String(body.date) : today()
        if (!lim.take('frame')) return send(res, 429, { error: 'the crew has hit its daily limit' })
        const items = await d.plate(jpeg) // the photo is not kept after this call
        if (!items.length) return send(res, 200, { items, say: "I couldn't tell what's in front of you. Try again with the plate in view." })
        for (const [k, m] of meals) if (Date.now() - m.at > 300_000) meals.delete(k)
        const mealId = randomUUID()
        meals.set(mealId, { items, date, slot, at: Date.now() })
        return send(res, 200, { mealId, items, say: `I see ${spokenList(items.map((i) => i.name))}. Log that as ${slot}?` })
      }
      if (parts[1] && parts[2] === 'log') {
        const meal = meals.get(parts[1])
        if (!meal) return send(res, 404, { error: 'no such meal, or it expired' })
        meals.delete(parts[1])
        const body = await json(req)
        if (body.yes !== true) return send(res, 200, { logged: false, say: "Okay, I didn't log it." })
        if (!d.canWrite) return send(res, 200, { logged: false, say: "Logging is switched off for now, so I didn't save it." })
        const r = await kitchen.call('kitchen_log_add', { date: meal.date, slot: meal.slot, items: meal.items })
        if (r.limit) return send(res, 200, { logged: false, say: "Logging meals needs GreenplateAi Plus, so I didn't save it." })
        if (!r.ok) return send(res, 200, { logged: false, say: "GreenplateAi didn't take it, so nothing was saved." })
        return send(res, 200, { logged: true, say: `Logged as ${meal.slot}.` })
      }
    }

    if (parts[0] === 'shopping' && parts[1] && req.method === 'POST') {
      const trip = trips.get(parts[1])
      if (!trip) return send(res, 404, { error: 'no such trip' })
      if (parts[2] === 'frame') {
        const body = await json(req, 4_000_000)
        const jpeg = String(body.jpegBase64 ?? '')
        if (!jpeg) return send(res, 400, { error: 'jpegBase64 is required' })
        if (!d.eyes) return send(res, 503, { error: 'vision is not set up yet', missing: d.missing ?? [] })
        if (!lim.take('frame')) return send(res, 429, { error: 'the crew has hit its daily limit' })
        const seen = await d.eyes(jpeg) // the frame is not kept after this call
        return send(res, 200, { seen: seen.item, say: noticeItem(trip, seen) })
      }
      if (parts[2] === 'checkout') return send(res, 200, { say: remaining(trip) })
    }

    return send(res, 404, { error: 'not found' })
  }

  return createServer((req, res) => { route(req, res).catch((e: Error) => send(res, e instanceof OverLimit ? 429 : 500, { error: e.message })) })
}

const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack']

const TALK_ONLY = "You are the GreenplateAi kitchen crew, speaking out loud through smart glasses. Answer in one or two short, friendly spoken sentences, no lists or markdown. The person's GreenplateAi kitchen (pantry, meal plan, shopping list) is not connected yet: if they ask about it, say it will be once they connect GreenplateAi. Never tell anyone what to eat, judge food, or talk about health, weight or diet."

/** The crew with no kitchen connected: a plain spoken reply from the model, no tools. */
type Said = { role: 'user' | 'assistant'; content: string }

/** The last lines of this chat, sent by the app with each request, so the crew remembers the conversation. Capped. */
export function chatHistory(raw: unknown): Said[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(-10).flatMap((l) => {
    const who = (l as { who?: unknown })?.who
    const text = String((l as { text?: unknown })?.text ?? '').slice(0, 500)
    if (!text || (who !== 'You' && who !== 'Crew')) return []
    return [{ role: who === 'You' ? 'user' as const : 'assistant' as const, content: text }]
  })
}

const QUICK_MODES: Mode[] = ['general', 'pantry_check', 'cooking']

const QUICK = "You are the GreenplateAi kitchen crew, speaking out loud through smart glasses in a running conversation. Below is a snapshot of the person's kitchen (pantry and this week's meal plan). Answer in one or two short, friendly spoken sentences, no lists or markdown. Use the snapshot for what they have and what's planned; it's fine to say something isn't there. For general cooking know-how (times, temperatures, when it's done, techniques, swaps, what could be made from what they have) answer from your own knowledge like a friend in the kitchen; never refuse just because it isn't on the plan. Read 'it', 'that', 'them' from the conversation so far. Talk like a friend in the kitchen: happy to chat about food, ideas, what to make, and small talk, and ask a short question back when it helps. The grocery list comes from this week's meal plan minus the pantry; when the plan is empty, say the list is empty because nothing is planned yet and offer to help plan a few meals. If the request needs changing anything (adding, removing, updating, logging, planning), building a shopping list, or recipe steps, reply with exactly CREW and nothing else. Never tell anyone what to eat, judge food, or talk about health, weight or diet."

/** Pantry and this week's plan, fetched together and kept for a minute so follow-ups are instant. */
export function kitchenSnapshot(ttlMs = 60_000, now = () => Date.now()) {
  let cached: { at: number; day: string; text: Promise<string> } | undefined
  return {
    get(kitchen: Kitchen, day: string): Promise<string> {
      if (cached && cached.day === day && now() - cached.at < ttlMs) return cached.text
      const to = new Date(Date.parse(day) + 6 * 86_400_000).toISOString().slice(0, 10)
      const text = Promise.all([kitchen.call('kitchen_pantry_list'), kitchen.call('kitchen_plan_list', { from: day, to })])
        .then(([pantry, plan]) => `Today is ${day}.\nPantry: ${pantry.ok ? pantry.text : 'unavailable'}\nMeal plan ${day} to ${to}: ${plan.ok ? plan.text : 'unavailable'}`)
      cached = { at: now(), day, text }
      text.catch(() => { cached = undefined })
      return text
    },
    clear() { cached = undefined },
  }
}

/** One quick call over the kitchen snapshot; undefined means "this needs the full crew". */
export async function quickAnswer(model: Model, kitchenText: () => Promise<string>, request: string, history: Said[] = []): Promise<{ answer: string; log?: RunLog; stoppedBecause?: string } | undefined> {
  const chat = [{ role: 'system' as const, content: `${QUICK}\n\n${(await kitchenText()).slice(0, 12_000)}` }, ...history, { role: 'user' as const, content: request }]
  const first = await model.turn(chat, [])
  const text = first.text.trim()
  if (!text || text.toUpperCase().startsWith('CREW')) return undefined
  if (!soundsLikeCoaching(text)) return { answer: text }
  const again = await model.turn([...chat, { role: 'assistant', content: text }, { role: 'user', content: REWRITE }], [])
  return { answer: again.text.trim() }
}

/** The crew with no kitchen connected: a plain spoken reply from the model, no tools. */
async function talkOnly(model: Model, request: string, history: Said[] = []): Promise<{ answer: string; log?: RunLog; stoppedBecause?: string }> {
  const chat = [{ role: 'system' as const, content: TALK_ONLY }, ...history, { role: 'user' as const, content: request }]
  const first = await model.turn(chat, [])
  if (!soundsLikeCoaching(first.text)) return { answer: first.text.trim() }
  const again = await model.turn([...chat, { role: 'assistant', content: first.text }, { role: 'user', content: REWRITE }], [])
  return { answer: again.text.trim() }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function json(req: IncomingMessage, limit = 64_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => { try { resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {}) } catch { resolve({}) } })
    req.on('error', reject)
  })
}
