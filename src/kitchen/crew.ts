// The kitchen crew: the first deployment of the fleet, inside GreenplateAi. Kitchen work only:
// plan, shop, stock, cook, log. The no-advice guard is the one place the hackathon's banned
// categories (nutrition coaching, health advice) are enforced.
import type { Model } from '../fleet/model.js'
import { runFleet, type Agent, type Budget, type Fleet, type FleetResult, type HandoffTool, type Kind, type LocalTool, type ServiceTool } from '../fleet/runtime.js'
import { REWRITE, soundsLikeCoaching } from './noadvice.js'
import type { Kitchen } from './service.js'
import { buildShoppingList, covers } from './shopping.js'

export type Mode = 'shopping' | 'capture' | 'cooking' | 'eating_out' | 'pantry_check' | 'general'
type Ctx = { kitchen: Kitchen }

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, required })
const day = { type: 'string', description: 'YYYY-MM-DD' }
const svc = (name: string, description: string, kind: Kind, parameters = obj(), askFirst = false): ServiceTool =>
  ({ via: 'service', def: { name, description, parameters }, kind, askFirst })

type Row = { id: string; name: string }
/** The row the person meant ("the milk", "eggs"): an exact name first, then a close one. */
export function rowNamed<T extends Row>(items: T[], said: string): T | undefined {
  const s = said.trim().toLowerCase().replace(/^(the|my|some) /, '')
  return items.find((i) => i.name.toLowerCase() === s) ?? items.find((i) => covers(i.name, s) || covers(s, i.name))
}

/** A change by name: voice says "the milk", the service wants its id, so read the list and find it. */
const byName = (name: string, description: string, list: string, change: (row: Row, args: Record<string, unknown>) => [string, Record<string, unknown>], extra: Record<string, unknown> = {}): LocalTool<Ctx> => ({
  via: 'local', kind: 'write', askFirst: true,
  def: { name, description, parameters: obj({ name: { type: 'string', description: 'The item as the person said it.' }, ...extra }, ['name']) },
  async run(args, env) {
    const kitchen = env.context.kitchen
    const l = await kitchen.call(list)
    const rows = ((l.data as { items?: Row[] } | null)?.items ?? [])
    const row = rowNamed(rows, String(args.name ?? ''))
    if (!row) return { text: `Nothing called "${args.name}" is there.`, serviceCalls: 1 }
    const [tool, a] = change(row, args)
    const r = await kitchen.call(tool, a)
    return { text: r.ok ? `Done: ${row.name}. ${r.text}` : r.text, serviceCalls: 2, note: `${name} ${row.name}` }
  },
})

const T = {
  pantryList: svc('kitchen_pantry_list', "The household's pantry: names, amounts, expiry dates.", 'read'),
  pantryAdd: svc('kitchen_pantry_add', 'Add one item to the pantry.', 'write', obj({ name: { type: 'string' }, quantity: { type: 'number' }, unit: { type: 'string' }, expires: day }, ['name']), true),
  pantryUpdate: byName('pantry_update', 'Change how much of a pantry item is left, by its name.', 'kitchen_pantry_list',
    (row, a) => ['kitchen_pantry_update', { id: row.id, quantity: a.quantity, ...(a.unit ? { unit: a.unit } : {}) }], { quantity: { type: 'number' }, unit: { type: 'string' } }),
  pantryRemove: byName('pantry_remove', 'Take an item out of the pantry (used up, thrown out), by its name.', 'kitchen_pantry_list', (row) => ['kitchen_pantry_remove', { id: row.id }]),
  groceryList: svc('kitchen_grocery_list', 'The grocery list the app shows (items added by hand and from the plan, ticked or not), plus what the plan still needs.', 'read', obj({ from: day, to: day })),
  groceryAdd: svc('kitchen_grocery_add', 'Add one item to the grocery list. One call per item.', 'write', obj({ name: { type: 'string' }, quantity: { type: 'number' }, unit: { type: 'string' } }, ['name']), true),
  groceryCheckOff: byName('grocery_check_off', 'Tick an item on the grocery list as bought, by its name; it goes into the pantry too.', 'kitchen_grocery_list', (row) => ['kitchen_grocery_update', { id: row.id, ticked: true }]),
  groceryRemove: byName('grocery_remove', 'Take an item off the grocery list, by its name.', 'kitchen_grocery_list', (row) => ['kitchen_grocery_remove', { id: row.id }]),
  suggest: svc('suggest_meals', 'Published GreenplateAi recipes for a meal type, optionally matching a few words ("quick chicken").', 'read', obj({ mealType: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] }, count: { type: 'number' }, intent: { type: 'string' } }, ['mealType'])),
  collections: svc('my_collections_list', "The household's recipe collections; Favourites is built in (id \"favourites\").", 'read'),
  collectionAdd: svc('my_collection_add', 'Save a recipe to a collection (id "favourites" for Favourites) by recipe id.', 'write', obj({ id: { type: 'string' }, recipeId: { type: 'string' } }, ['id', 'recipeId']), true),
  planList: svc('kitchen_plan_list', 'Planned meals between two dates.', 'read', obj({ from: day, to: day }, ['from', 'to'])),
  // Local so the question can name the recipe: the title is said, not sent (the service refuses extra fields).
  planAdd: {
    via: 'local', kind: 'write', askFirst: true,
    def: { name: 'kitchen_plan_add', description: 'Put a recipe on the plan for a date and slot; give its title too.', parameters: obj({ date: day, slot: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] }, recipeId: { type: 'string' }, title: { type: 'string' } }, ['date', 'slot', 'recipeId']) },
    async run(args, env) {
      const r = await env.context.kitchen.call('kitchen_plan_add', { date: args.date, slot: args.slot, recipeId: args.recipeId })
      return { text: r.text, serviceCalls: 1, note: String(args.title ?? args.recipeId) }
    },
  } satisfies LocalTool<Ctx>,
  planRemove: svc('kitchen_plan_remove', 'Take a meal off the plan.', 'write', obj({ id: { type: 'string' } }, ['id']), true),
  myRecipes: svc('my_recipes_list', "The household's own saved recipes.", 'read', obj({ search: { type: 'string' } })),
  recipeGet: svc('my_recipe_get', 'One saved recipe with ingredients and steps.', 'read', obj({ id: { type: 'string' } }, ['id'])),
  logDay: svc('kitchen_log_day', 'What was logged on a date.', 'read', obj({ date: day }, ['date'])),
  logAdd: svc('kitchen_log_add', 'Log a meal: a date, a slot, and items (each a recipeId, or a name; nutrition is estimated when not given).', 'write', obj({ date: day, slot: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] }, items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, recipeId: { type: 'string' } } } } }, ['date', 'slot']), true),
  logRemove: svc('kitchen_log_remove', 'Remove one logged item (id) or a whole meal (mealId), both from kitchen_log_day.', 'write', obj({ id: { type: 'string' }, mealId: { type: 'string' } }), true),
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
    handoff('shopper', 'the grocery list: what to buy, adding to it, ticking things off, taking things off'),
    handoff('pantry', "what's in the pantry, adding, using up or removing items, what's about to go off"),
    handoff('planner', 'planning or repairing the week, recipe ideas, saving recipes to favourites'),
    handoff('logger', 'recording what was eaten, or fixing the food log'),
    handoff('chef', 'cooking a planned recipe, step by step'),
  ] },
  shopper: { name: 'shopper', job: 'You keep the grocery list: read it, add what the person asks for (one add per item, all in the same turn), tick off what they bought, take off what they no longer need, and work out what the plan still needs.', tools: [T.groceryList, T.groceryAdd, T.groceryCheckOff, T.groceryRemove, T.shoppingList, T.pantryList] },
  pantry: { name: 'pantry', job: 'You keep the pantry: what is there, adding items, changing how much is left, removing what is used up, and what is about to go off.', tools: [T.pantryList, T.pantryAdd, T.pantryUpdate, T.pantryRemove, T.planList, T.myRecipes] },
  planner: { name: 'planner', job: "You build or repair the week's plan around the pantry, find recipe ideas (the household's own recipes and published GreenplateAi recipes), and save recipes to Favourites.", tools: [T.planList, T.pantryList, T.myRecipes, T.suggest, T.planAdd, T.planRemove, T.collections, T.collectionAdd] },
  logger: { name: 'logger', job: 'You record what was eaten and fix the food log. Items from a photo are estimates and are saved as such.', tools: [T.logDay, T.logAdd, T.logRemove] },
  chef: { name: 'chef', job: "You walk the person through tonight's planned recipe and keep the pantry right as ingredients are used.", tools: [T.planList, T.recipeGet, T.pantryList, T.pantryUpdate] },
}

export const KITCHEN_CREW: Fleet<Ctx> = {
  lead: 'lead',
  agents,
  rules: [
    'Never give health, diet or medical advice, and never tell anyone what they should eat.',
    'Only use recipes and numbers a tool returned; never invent them.',
    'Read the pantry and the plan once per run, not once per item.',
    'Make all the changes a request needs in one turn, so the person is asked once.',
    'Put the recipe title in a plan change (title), so the question can name it.',
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
