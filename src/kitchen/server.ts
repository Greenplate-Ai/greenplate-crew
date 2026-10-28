// The crew service the glasses app talks to. Plain Node http, no framework.
//   POST /ask            {request, mode}            -> {runId}
//   GET  /runs/:id                                  -> {status, answer?, question?, spoken?, steps}
//   POST /runs/:id/answer {yes}                     -> {ok}
//   POST /shopping/start {from, to}                 -> {tripId, needs}
//   POST /shopping/:id/frame {jpegBase64}           -> {say?}
//   POST /shopping/:id/checkout                     -> {say}
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
import { noticeItem, remaining, type Seen, type ShoppingTrip } from './vision.js'

interface RunState {
  status: 'running' | 'waiting' | 'done' | 'failed'
  answer?: string
  question?: string
  resolve?: (yes: boolean) => void
  log?: RunLog
  stoppedBecause?: string
}

export interface ServerDeps {
  /** Missing pieces leave the service up: /health and /speak still work, the rest answer 503 naming what's missing. */
  model?: Model
  /** A quicker model for plain conversation (no kitchen tools); falls back to `model`. */
  talker?: Model
  kitchen?: Kitchen
  eyes?: (jpegBase64: string) => Promise<Seen>
  missing?: string[]
  speak?: Speak
  canWrite: boolean
  appToken: string
  today?: () => string
  /** Spending caps; a fresh default limiter when not given. */
  limits?: ReturnType<typeof limiter>
}

const MODES: Mode[] = ['shopping', 'capture', 'cooking', 'eating_out', 'pantry_check', 'general']

export function crewServer(d: ServerDeps) {
  const runs = new Map<string, RunState>()
  const trips = new Map<string, ShoppingTrip>()
  const today = d.today ?? (() => new Date().toISOString().slice(0, 10))
  const lim = d.limits ?? limiter()

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!lim.request()) return send(res, 429, { error: 'too many requests, slow down' })
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, voice: !!d.speak, talk: !!d.model, crew: !!(d.model && d.kitchen), missing: d.missing ?? [], usedToday: lim.today() })
    }
    if (req.headers.authorization !== `Bearer ${d.appToken}`) return send(res, 401, { error: 'unauthorized' })
    const url = new URL(req.url ?? '/', 'http://crew')
    const parts = url.pathname.split('/').filter(Boolean)

    // Talking (/ask, /runs) needs only the model; with no kitchen yet the crew just talks, no kitchen tools.
    const needsModel = (req.method === 'POST' && url.pathname === '/ask') || parts[0] === 'runs'
    const needsCrew = req.method === 'POST' && parts[0] === 'shopping'
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
      const work = !d.kitchen ? talkOnly(d.talker ?? model, request, history) : askCrew(request, mode, {
        model, kitchen, canWrite: d.canWrite, today: today(),
        budget: { maxTurns: 6, maxServiceCalls: 40, maxUsd: 0.25 },
        confirm: (question) => new Promise<boolean>((resolve) => { run.status = 'waiting'; run.question = question; run.resolve = resolve }),
      }, id)
      const started = Date.now()
      work.then((r) => {
        // Start the voice now, so the app's /speak for this answer finds it ready (or in flight) in the cache.
        if (d.speak && r.answer) d.speak(r.answer).catch(() => {})
        Object.assign(run, { status: 'done', answer: r.answer, log: r.log, stoppedBecause: r.stoppedBecause, question: undefined, resolve: undefined })
        console.log(`ask answered in ${Date.now() - started} ms (${d.kitchen ? 'crew' : 'talk'}, ${history.length} lines of history)`)
      }).catch((e: Error) => { Object.assign(run, { status: 'failed', answer: `Something went wrong: ${e.message}` }) })
      return send(res, 202, { runId: id })
    }

    if (parts[0] === 'runs' && parts[1]) {
      const run = runs.get(parts[1])
      if (!run) return send(res, 404, { error: 'no such run' })
      if (req.method === 'GET' && parts.length === 2) {
        return send(res, 200, { status: run.status, answer: run.answer, question: run.question, spoken: run.question ? spokenQuestion(run.question) : undefined, stoppedBecause: run.stoppedBecause, steps: run.log?.lines() ?? [], usd: run.log?.usd ?? 0 })
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
