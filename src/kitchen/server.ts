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
import { buildShoppingList } from './shopping.js'
import { spokenQuestion } from './speak.js'
import type { Speak } from './voice.js'
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
  model: Model
  kitchen: Kitchen
  eyes: (jpegBase64: string) => Promise<Seen>
  speak?: Speak
  canWrite: boolean
  appToken: string
  today?: () => string
}

const MODES: Mode[] = ['shopping', 'capture', 'cooking', 'eating_out', 'pantry_check', 'general']

export function crewServer(d: ServerDeps) {
  const runs = new Map<string, RunState>()
  const trips = new Map<string, ShoppingTrip>()
  const today = d.today ?? (() => new Date().toISOString().slice(0, 10))

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${d.appToken}`) return send(res, 401, { error: 'unauthorized' })
    const url = new URL(req.url ?? '/', 'http://crew')
    const parts = url.pathname.split('/').filter(Boolean)

    if (req.method === 'POST' && url.pathname === '/ask') {
      const body = await json(req)
      const request = String(body.request ?? '').slice(0, 500)
      const mode = (MODES.includes(body.mode as Mode) ? body.mode : 'general') as Mode
      if (!request) return send(res, 400, { error: 'request is required' })
      const id = randomUUID()
      const run: RunState = { status: 'running' }
      runs.set(id, run)
      askCrew(request, mode, {
        model: d.model, kitchen: d.kitchen, canWrite: d.canWrite, today: today(),
        budget: { maxTurns: 6, maxServiceCalls: 40, maxUsd: 0.25 },
        confirm: (question) => new Promise<boolean>((resolve) => { run.status = 'waiting'; run.question = question; run.resolve = resolve }),
      }, id).then((r) => {
        Object.assign(run, { status: 'done', answer: r.answer, log: r.log, stoppedBecause: r.stoppedBecause, question: undefined, resolve: undefined })
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
      const list = await buildShoppingList(d.kitchen, from, to)
      const pantry = await d.kitchen.call('kitchen_pantry_list')
      const names = ((pantry.data as { items?: { name: string }[] })?.items ?? []).map((p) => p.name)
      const id = randomUUID()
      trips.set(id, { list, pantry: names, checked: new Set(), announced: new Set() })
      return send(res, 200, { tripId: id, needs: list.needs.map((n) => n.name), unknownRecipes: list.unknownRecipes })
    }

    if (req.method === 'POST' && url.pathname === '/speak') {
      if (!d.speak) return send(res, 404, { error: 'no voice configured' })
      const body = await json(req)
      const text = String(body.text ?? '').trim()
      if (!text) return send(res, 400, { error: 'text is required' })
      const audio = await d.speak(text)
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
        const seen = await d.eyes(jpeg) // the frame is not kept after this call
        return send(res, 200, { seen: seen.item, say: noticeItem(trip, seen) })
      }
      if (parts[2] === 'checkout') return send(res, 200, { say: remaining(trip) })
    }

    return send(res, 404, { error: 'not found' })
  }

  return createServer((req, res) => { route(req, res).catch((e: Error) => send(res, 500, { error: e.message })) })
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
