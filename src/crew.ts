// The crew: a lead that hands each request to one specialist, and specialists that each own a few
// tools. One runtime runs them all, with a budget, approval before changing the plan, GreenplateAi's
// own limits respected, and every step in the run log.
import { isLimit, type Kitchen } from './kitchen.js'
import type { Model, Msg, ToolCall, ToolDef } from './model.js'
import { RunLog } from './runlog.js'
import { REWRITE, soundsLikeCoaching } from './noadvice.js'
import { buildShoppingList } from './shopping.js'

export type Mode = 'shopping' | 'capture' | 'cooking' | 'eating_out' | 'pantry_check' | 'general'
export type AgentName = 'lead' | 'shopper' | 'planner' | 'logger' | 'pantry' | 'chef'

type Kind = 'read' | 'write'
interface KitchenTool { via: 'kitchen'; def: ToolDef; kind: Kind; askFirst?: boolean }
interface LocalTool { via: 'local'; def: ToolDef; kind: Kind; run(args: Record<string, unknown>, ctx: Ctx): Promise<string> }
interface HandoffTool { via: 'handoff'; def: ToolDef; kind: 'read'; to: AgentName }
type Tool = KitchenTool | LocalTool | HandoffTool

interface Agent { name: AgentName; job: string; tools: Tool[] }

export interface Budget { maxTurns: number; maxKitchenCalls: number; maxUsd: number }
export interface CrewOptions {
  model: Model
  kitchen: Kitchen
  /** May the crew save changes on this household's plan? Free tier: false (suggestions only). */
  canWrite: boolean
  budget: Budget
  /** Asked before anything that changes the meal plan. */
  confirm(question: string): Promise<boolean>
  today: string
}
interface Ctx { opts: CrewOptions; log: RunLog; calls: { n: number } }

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, required })
const day = { type: 'string', description: 'YYYY-MM-DD' }

const kitchenTool = (name: string, description: string, kind: Kind, parameters = obj(), askFirst = false): KitchenTool =>
  ({ via: 'kitchen', def: { name, description, parameters }, kind, askFirst })

const T = {
  pantryList: kitchenTool('kitchen_pantry_list', "The household's pantry: names, amounts, expiry dates.", 'read'),
  pantryAdd: kitchenTool('kitchen_pantry_add', 'Add one item to the pantry.', 'write', obj({ name: { type: 'string' }, quantity: { type: 'number' }, unit: { type: 'string' }, expires: day }, ['name'])),
  pantryUpdate: kitchenTool('kitchen_pantry_update', 'Change a pantry item (amount used, expiry).', 'write', obj({ id: { type: 'string' }, quantity: { type: 'number' } }, ['id'])),
  planList: kitchenTool('kitchen_plan_list', 'Planned meals between two dates.', 'read', obj({ from: day, to: day }, ['from', 'to'])),
  planAdd: kitchenTool('kitchen_plan_add', 'Put a recipe on the plan for a date and slot.', 'write', obj({ date: day, slot: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] }, recipeId: { type: 'string' } }, ['date', 'slot', 'recipeId']), true),
  planRemove: kitchenTool('kitchen_plan_remove', 'Take a meal off the plan.', 'write', obj({ id: { type: 'string' } }, ['id']), true),
  myRecipes: kitchenTool('my_recipes_list', "The household's own saved recipes.", 'read', obj({ search: { type: 'string' } })),
  recipeGet: kitchenTool('my_recipe_get', 'One saved recipe with ingredients and steps.', 'read', obj({ id: { type: 'string' } }, ['id'])),
  logDay: kitchenTool('kitchen_log_day', 'What was logged on a date.', 'read', obj({ date: day }, ['date'])),
  logAdd: kitchenTool('kitchen_log_add', 'Log a meal as items; anything from a photo is an estimate.', 'write', obj({ date: day, slot: { type: 'string' }, items: { type: 'array', items: { type: 'object' } } }, ['date', 'slot'])),
  shoppingList: {
    via: 'local', kind: 'read',
    def: { name: 'shopping_list', description: 'What to buy for the planned meals, minus what is already in the pantry.', parameters: obj({ from: day, to: day }, ['from', 'to']) },
    async run(args, ctx) {
      const list = await buildShoppingList(ctx.opts.kitchen, String(args.from), String(args.to))
      ctx.calls.n += list.toolCalls
      ctx.log.add({ agent: 'shopper', kind: 'tool', tool: 'shopping_list', outcome: 'ok', note: `${list.needs.length} to buy, ${list.alreadyHave.length} already home` })
      return JSON.stringify(list)
    },
  } satisfies LocalTool,
} as const

const handoff = (to: AgentName, when: string): HandoffTool =>
  ({ via: 'handoff', kind: 'read', to, def: { name: `ask_${to}`, description: `Hand the request to the ${to}: ${when}`, parameters: obj({ task: { type: 'string', description: 'What the specialist should do, in one sentence.' } }, ['task']) } })

export const AGENTS: Record<AgentName, Agent> = {
  lead: { name: 'lead', job: 'You run the household kitchen crew. Hand each request to exactly one specialist, then answer the person in one or two short spoken sentences.', tools: [
    handoff('shopper', 'what to buy, the shopping list, receipts into the pantry'),
    handoff('pantry', "what's running low or about to go off, using it up"),
    handoff('planner', 'planning or repairing the week'),
    handoff('logger', 'recording what was eaten'),
    handoff('chef', 'cooking a planned recipe, step by step'),
  ] },
  shopper: { name: 'shopper', job: 'You work out what to buy and put bought items into the pantry.', tools: [T.shoppingList, T.pantryList, T.pantryAdd] },
  pantry: { name: 'pantry', job: 'You find what is running low or about to go off and suggest using it first.', tools: [T.pantryList, T.planList, T.myRecipes] },
  planner: { name: 'planner', job: "You build or repair the week's plan around the pantry and the household's own targets.", tools: [T.planList, T.pantryList, T.myRecipes, T.planAdd, T.planRemove] },
  logger: { name: 'logger', job: 'You record what was eaten. Items from a photo are estimates and are saved as such.', tools: [T.logDay, T.logAdd] },
  chef: { name: 'chef', job: "You walk the person through tonight's planned recipe and keep the pantry right as ingredients are used.", tools: [T.planList, T.recipeGet, T.pantryList, T.pantryUpdate] },
}

const RULES = [
  'Never give health, diet or medical advice, and never tell anyone what they should eat.',
  'Only use recipes and numbers a tool returned; never invent them.',
  'Read the pantry and the plan once per run, not once per item.',
  'Speak briefly: the answer is read aloud on glasses.',
].join(' ')

export const MODE_LEAD: Record<Mode, string> = {
  shopping: 'The person is at the store.',
  capture: 'The person is showing a recipe to save.',
  cooking: 'The person is cooking now.',
  eating_out: 'The person is eating away from home.',
  pantry_check: 'The person is checking what is in the kitchen.',
  general: '',
}

export interface CrewResult { answer: string; stoppedBecause: 'done' | 'turns' | 'kitchen_calls' | 'cost' | 'limit'; log: RunLog }

export async function askCrew(request: string, mode: Mode, opts: CrewOptions, runId = `run-${Date.now()}`): Promise<CrewResult> {
  const log = new RunLog(runId, request)
  const ctx: Ctx = { opts, log, calls: { n: 0 } }
  const context = `Today is ${opts.today}. ${MODE_LEAD[mode]}`.trim()
  const r = await runAgent('lead', `${context}\n\nThe person said: "${request}"`, ctx)
  let answer = r.answer
  const hit = soundsLikeCoaching(answer)
  if (hit) {
    // One rewrite, then a neutral fallback: the crew never coaches, even when a model slips.
    log.add({ agent: 'lead', kind: 'think', outcome: 'refused', note: `no-advice guard: "${hit}"` })
    const t = await opts.model.turn([{ role: 'system', content: `${AGENTS.lead.job} ${RULES}` }, { role: 'user', content: `${REWRITE}\n\nAnswer to rewrite: "${answer}"` }], [])
    log.add({ agent: 'lead', kind: 'think', inputTokens: t.inputTokens, outputTokens: t.outputTokens, usd: (t.inputTokens * opts.model.price.input + t.outputTokens * opts.model.price.output) / 1e6 })
    answer = soundsLikeCoaching(t.text) ? 'Done. Check the app for the details.' : t.text
  }
  log.add({ agent: 'lead', kind: 'stop', note: r.stoppedBecause })
  return { answer, stoppedBecause: r.stoppedBecause, log }
}

async function runAgent(name: AgentName, task: string, ctx: Ctx): Promise<Omit<CrewResult, 'log'>> {
  const agent = AGENTS[name]
  const { model, budget } = ctx.opts
  const messages: Msg[] = [{ role: 'system', content: `${agent.job} ${RULES}` }, { role: 'user', content: task }]
  const byName = new Map(agent.tools.map((t) => [t.def.name, t]))

  for (let turnNo = 0; turnNo < budget.maxTurns; turnNo++) {
    const turn = await model.turn(messages, agent.tools.map((t) => t.def))
    const usd = (turn.inputTokens * model.price.input + turn.outputTokens * model.price.output) / 1e6
    ctx.log.add({ agent: name, kind: 'think', inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, usd })
    messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls })
    if (turn.toolCalls.length === 0) return { answer: turn.text, stoppedBecause: 'done' }
    if (ctx.log.usd > budget.maxUsd) return { answer: turn.text || 'I stopped to stay inside the budget.', stoppedBecause: 'cost' }

    // Hand-offs the lead issues together run in parallel (the fleet fans out); every other tool runs
    // in order, so writes never race each other.
    const fanOut = turn.toolCalls.length > 1 && turn.toolCalls.every((c) => byName.get(c.name)?.via === 'handoff')
    if (fanOut) ctx.log.add({ agent: name, kind: 'handoff', note: `in parallel: ${turn.toolCalls.map((c) => byName.get(c.name)?.def.name).join(', ')}` })
    const outs = fanOut
      ? await Promise.all(turn.toolCalls.map((c) => runTool(name, byName.get(c.name), c, ctx)))
      : await (async () => {
          const acc: Awaited<ReturnType<typeof runTool>>[] = []
          for (const c of turn.toolCalls) {
            const o = await runTool(name, byName.get(c.name), c, ctx)
            acc.push(o)
            if (o.stop) break
          }
          return acc
        })()
    for (const [i, out] of outs.entries()) {
      if (out.stop) return { answer: out.text, stoppedBecause: out.stop }
      messages.push({ role: 'tool', toolCallId: turn.toolCalls[i]!.id, content: out.text })
    }
  }
  return { answer: 'I ran out of steps before finishing.', stoppedBecause: 'turns' }
}

async function runTool(agent: AgentName, tool: Tool | undefined, c: ToolCall, ctx: Ctx): Promise<{ text: string; stop?: CrewResult['stoppedBecause'] }> {
  const { opts, log } = ctx
  if (!tool) {
    log.add({ agent, kind: 'tool', tool: c.name, outcome: 'refused', note: 'not this agent’s tool' })
    return { text: `${c.name} is not one of your tools.` }
  }
  if (tool.via === 'handoff') {
    log.add({ agent, kind: 'handoff', tool: tool.to, note: String(c.args.task ?? '') })
    const r = await runAgent(tool.to, String(c.args.task ?? ''), ctx)
    return r.stoppedBecause === 'done' ? { text: r.answer } : { text: r.answer, stop: r.stoppedBecause }
  }
  if (tool.kind === 'write' && !opts.canWrite) {
    log.add({ agent, kind: 'tool', tool: tool.def.name, outcome: 'preview', note: 'plan does not save changes' })
    return { text: 'This household’s plan shows suggestions only. Describe the change instead of saving it.' }
  }
  if (tool.via === 'kitchen' && tool.askFirst) {
    const yes = await opts.confirm(`${agent} wants to ${c.name.replace('kitchen_', '').replace('_', ' ')}: ${JSON.stringify(c.args)}`)
    log.add({ agent, kind: 'ask', tool: c.name, outcome: yes ? 'ok' : 'declined' })
    if (!yes) return { text: 'The person said no. Do not make this change.' }
  }
  if (ctx.calls.n >= opts.budget.maxKitchenCalls) {
    log.add({ agent, kind: 'stop', note: 'kitchen call budget reached' })
    return { text: 'I stopped to stay inside today’s plan limit.', stop: 'kitchen_calls' }
  }
  if (tool.via === 'local') {
    try { return { text: await tool.run(c.args, ctx) } } catch (e) {
      log.add({ agent, kind: 'tool', tool: c.name, outcome: 'error', note: (e as Error).message })
      return { text: `That failed: ${(e as Error).message}` }
    }
  }
  ctx.calls.n++
  const r = await opts.kitchen.call(c.name, c.args)
  if (isLimit(r)) {
    log.add({ agent, kind: 'tool', tool: c.name, outcome: 'limit', note: r.text })
    return { text: r.text, stop: 'limit' }
  }
  log.add({ agent, kind: 'tool', tool: c.name, outcome: r.ok ? 'ok' : 'refused' })
  return { text: r.text }
}
