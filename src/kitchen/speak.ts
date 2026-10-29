// Turns an approval request from the fleet ("planner wants to kitchen_plan_add: {...}", one line per
// change when several are asked together) into a short question that can be spoken through the glasses.
import { spokenList } from './vision.js'

type Args = Record<string, unknown>
const names = (l: Args[]) => spokenList(l.map((a) => String(a.name ?? a.title ?? 'that item')))
const one = (l: Args[]): Args => l[0] ?? {}

const ACTIONS: Record<string, (l: Args[]) => string> = {
  kitchen_plan_add: (l) => l.map((a) => `put ${a.title ?? 'a recipe'} on the plan for ${a.date ?? 'that day'}${a.slot ? ` ${a.slot}` : ''}`).join(', and '),
  kitchen_plan_remove: (l) => l.length > 1 ? `take ${l.length} meals off the plan` : `take ${one(l).title ?? 'that meal'} off the plan${one(l).date ? ` for ${one(l).date}` : ''}`,
  kitchen_pantry_add: (l) => `add ${names(l)} to the pantry`,
  kitchen_pantry_update: (l) => `update ${names(l)} in the pantry`,
  kitchen_pantry_remove: (l) => `remove ${names(l)} from the pantry`,
  pantry_update: (l) => `${l.map((a) => `set ${a.name ?? 'that'} to ${a.quantity ?? 'a new amount'}${a.unit ? ` ${a.unit}` : ''}`).join(', and ')} in the pantry`,
  pantry_remove: (l) => `remove ${names(l)} from the pantry`,
  kitchen_grocery_add: (l) => `add ${names(l)} to the grocery list`,
  grocery_check_off: (l) => `check off ${names(l)}`,
  grocery_remove: (l) => `take ${names(l)} off the grocery list`,
  kitchen_log_add: (l) => {
    const foods = l.flatMap((a) => Array.isArray(a.items) && a.items.length
      ? a.items.map((i) => String((i as Args | null)?.name ?? 'an item'))
      : [String(a.name ?? a.title ?? 'that meal')])
    return `log ${spokenList(foods)}${one(l).slot ? ` as ${one(l).slot}` : ''} in the food log`
  },
  kitchen_log_remove: (l) => l.length > 1 ? `remove ${l.length} entries from the food log` : 'remove that entry from the food log',
  feedback_add: (l) => `send ${l.length > 1 ? 'that feedback' : `"${String(one(l).text ?? 'that').slice(0, 90)}"`} to the GreenplateAi team`,
  my_collection_add: (l) => `save ${l.length > 1 ? 'those recipes' : 'that recipe'} to ${one(l).id === 'favourites' ? 'your favourites' : 'that collection'}`,
}

export function spokenQuestion(question: string): string {
  const m = /^(\w+) wants to (.*)$/s.exec(question)
  if (!m) return `${question}. Yes or no?`
  const [, agent = 'crew', rest = ''] = m
  // Group the changes by tool, so three adds read as one: "add milk, eggs and bread to the grocery list".
  const byTool = new Map<string, Args[]>()
  for (const line of rest.split('\n')) {
    const c = /^(\w+): (.*)$/s.exec(line.trim())
    if (!c) continue
    let args: Args = {}
    try { args = JSON.parse(c[2] ?? '{}') as Args } catch { /* keep empty */ }
    byTool.set(c[1]!, [...(byTool.get(c[1]!) ?? []), args])
  }
  if (!byTool.size) return `${question}. Yes or no?`
  const actions = [...byTool].map(([tool, l]) => ACTIONS[tool]?.(l) ?? tool.replace(/_/g, ' '))
  return `The ${agent} wants to ${spokenList(actions)}. Yes or no?`
}
