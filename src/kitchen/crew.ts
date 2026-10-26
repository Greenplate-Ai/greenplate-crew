// The kitchen crew: the first deployment of the fleet, inside GreenplateAi. Kitchen work only:
// plan, shop, stock, cook, log. The no-advice guard is the one place the hackathon's banned
// categories (nutrition coaching, health advice) are enforced.
import type { Model } from '../fleet/model.js'
import { runFleet, type Agent, type Budget, type Fleet, type FleetResult, type HandoffTool, type Kind, type LocalTool, type ServiceTool } from '../fleet/runtime.js'
import { REWRITE, soundsLikeCoaching } from './noadvice.js'
import type { Kitchen } from './service.js'
import { buildShoppingList } from './shopping.js'

export type Mode = 'shopping' | 'capture' | 'cooking' | 'eating_out' | 'pantry_check' | 'general'
type Ctx = { kitchen: Kitchen }

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, required })
const day = { type: 'string', description: 'YYYY-MM-DD' }
const svc = (name: string, description: string, kind: Kind, parameters = obj(), askFirst = false): ServiceTool =>
  ({ via: 'service', def: { name, description, parameters }, kind, askFirst })

const T = {
  pantryList: svc('kitchen_pantry_list', "The household's pantry: names, amounts, expiry dates.", 'read'),
  pantryAdd: svc('kitchen_pantry_add', 'Add one item to the pantry.', 'write', obj({ name: { type: 'string' }, quantity: { type: 'number' }, unit: { type: 'string' }, expires: day }, ['name'])),
  pantryUpdate: svc('kitchen_pantry_update', 'Change a pantry item (amount used, expiry).', 'write', obj({ id: { type: 'string' }, quantity: { type: 'number' } }, ['id'])),
  planList: svc('kitchen_plan_list', 'Planned meals between two dates.', 'read', obj({ from: day, to: day }, ['from', 'to'])),
  planAdd: svc('kitchen_plan_add', 'Put a recipe on the plan for a date and slot.', 'write', obj({ date: day, slot: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] }, recipeId: { type: 'string' } }, ['date', 'slot', 'recipeId']), true),
  planRemove: svc('kitchen_plan_remove', 'Take a meal off the plan.', 'write', obj({ id: { type: 'string' } }, ['id']), true),
  myRecipes: svc('my_recipes_list', "The household's own saved recipes.", 'read', obj({ search: { type: 'string' } })),
  recipeGet: svc('my_recipe_get', 'One saved recipe with ingredients and steps.', 'read', obj({ id: { type: 'string' } }, ['id'])),
  logDay: svc('kitchen_log_day', 'What was logged on a date.', 'read', obj({ date: day }, ['date'])),
  logAdd: svc('kitchen_log_add', 'Log a meal as items; anything from a photo is an estimate.', 'write', obj({ date: day, slot: { type: 'string' }, items: { type: 'array', items: { type: 'object' } } }, ['date', 'slot'])),
  shoppingList: {
    via: 'local', kind: 'read',
    def: { name: 'shopping_list', description: 'What to buy for the planned meals, minus what is already in the pantry.', parameters: obj({ from: day, to: day }, ['from', 'to']) },
    async run(args, env) {
      const list = await buildShoppingList(env.context.kitchen, String(args.from), String(args.to))
      return { text: JSON.stringify(list), serviceCalls: list.toolCalls, note: `${list.needs.length} to buy, ${list.alreadyHave.length} already home` }
    },
  } satisfies LocalTool<Ctx>,
}

const handoff = (to: string, when: string): HandoffTool =>
  ({ via: 'handoff', kind: 'read', to, def: { name: `ask_${to}`, description: `Hand the request to the ${to}: ${when}`, parameters: obj({ task: { type: 'string', description: 'What the specialist should do, in one sentence.' } }, ['task']) } })

const agents: Record<string, Agent<Ctx>> = {
  lead: { name: 'lead', job: 'You run the household kitchen crew. Hand each request to the right specialist, or to several at once when it needs them, then answer the person in one or two short spoken sentences.', tools: [
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

export const KITCHEN_CREW: Fleet<Ctx> = {
  lead: 'lead',
  agents,
  rules: [
    'Never give health, diet or medical advice, and never tell anyone what they should eat.',
    'Only use recipes and numbers a tool returned; never invent them.',
    'Read the pantry and the plan once per run, not once per item.',
    'Speak briefly: the answer is read aloud on glasses.',
  ].join(' '),
  guard: { check: soundsLikeCoaching, rewrite: REWRITE, fallback: 'Done. Check the app for the details.' },
}

export const MODE_CONTEXT: Record<Mode, string> = {
  shopping: 'The person is at the store.',
  capture: 'The person is showing a recipe to save.',
  cooking: 'The person is cooking now.',
  eating_out: 'The person is eating away from home.',
  pantry_check: 'The person is checking what is in the kitchen.',
  general: '',
}

export interface CrewOptions {
  model: Model
  kitchen: Kitchen
  canWrite: boolean
  budget: Budget
  confirm(question: string): Promise<boolean>
  today: string
}

export function askCrew(request: string, mode: Mode, o: CrewOptions, runId?: string): Promise<FleetResult> {
  const task = `${`Today is ${o.today}. ${MODE_CONTEXT[mode]}`.trim()}\n\nThe person said: "${request}"`
  return runFleet(KITCHEN_CREW, task, { model: o.model, service: o.kitchen, context: { kitchen: o.kitchen }, canWrite: o.canWrite, budget: o.budget, confirm: o.confirm }, runId)
}
