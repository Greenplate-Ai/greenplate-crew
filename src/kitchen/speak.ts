// Turns an approval request from the fleet ("planner wants to kitchen_plan_add: {...}") into a
// short question that can be spoken through the glasses.
const ACTIONS: Record<string, (a: Record<string, unknown>) => string> = {
  kitchen_plan_add: (a) => `put ${a.title ?? 'a recipe'} on the plan for ${a.date ?? 'that day'}${a.slot ? ` ${a.slot}` : ''}`,
  kitchen_plan_remove: (a) => `take ${a.title ?? 'that meal'} off the plan${a.date ? ` for ${a.date}` : ''}`,
  kitchen_pantry_add: (a) => `add ${a.name ?? 'that item'} to the pantry`,
  kitchen_pantry_update: (a) => `update ${a.name ?? 'that item'} in the pantry`,
  kitchen_pantry_remove: (a) => `remove ${a.name ?? 'that item'} from the pantry`,
  kitchen_log_add: (a) => `log ${a.name ?? a.title ?? 'that meal'} in the food log`,
  kitchen_log_remove: () => 'remove that entry from the food log',
}

export function spokenQuestion(question: string): string {
  const m = /^(\w+) wants to (\w+): (.*)$/s.exec(question)
  if (!m) return `${question}. Yes or no?`
  const [, agent = "crew", tool = "", raw = "{}"] = m
  let args: Record<string, unknown> = {}
  try { args = JSON.parse(raw) as Record<string, unknown> } catch { /* keep empty */ }
  const action = ACTIONS[tool]?.(args) ?? tool.replace(/_/g, ' ')
  return `The ${agent} wants to ${action}. Yes or no?`
}
