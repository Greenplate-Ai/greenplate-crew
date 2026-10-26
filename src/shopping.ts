// What to buy: the ingredients of the planned recipes, minus what the pantry already holds.
// GreenplateAi has no shopping-list tool; this is new crew work, computed here and shown to the person.
import type { Kitchen } from './kitchen.js'

export interface Need { name: string; qty?: number; unit?: string; forMeals: string[] }
export interface ShoppingList { from: string; to: string; needs: Need[]; alreadyHave: string[]; unknownRecipes: string[]; toolCalls: number }

const norm = (s: string): string =>
  s.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/(ies)$/, 'y').replace(/(?<![s])s$/, '')

/** True when the pantry item covers the ingredient by name ("eggs" covers "large egg"). */
export function covers(pantryName: string, ingredientName: string): boolean {
  const p = norm(pantryName)
  const i = norm(ingredientName)
  if (!p || !i) return false
  if (p === i) return true
  const pw = p.split(' ')
  const iw = i.split(' ')
  const pHead = pw[pw.length - 1]!
  const iHead = iw[iw.length - 1]!
  return pHead === iHead && (pw.length === 1 || iw.length === 1 || pw.some((w) => iw.includes(w) && w !== pHead))
}

export async function buildShoppingList(kitchen: Kitchen, from: string, to: string): Promise<ShoppingList> {
  let toolCalls = 0
  const plan = await kitchen.call('kitchen_plan_list', { from, to }); toolCalls++
  const pantry = await kitchen.call('kitchen_pantry_list'); toolCalls++
  const meals = ((plan.data as { items?: { recipeId?: string; title?: string; recipe?: { id?: string; title?: string } }[] })?.items ?? [])
  const pantryNames = ((pantry.data as { items?: { name: string }[] })?.items ?? []).map((p) => p.name)

  const byName = new Map<string, Need>()
  const alreadyHave = new Set<string>()
  const unknownRecipes: string[] = []
  const seen = new Map<string, { title: string; ingredients: { qty?: number; unit?: string; name: string }[] } | null>()

  for (const m of meals) {
    const id = m.recipeId ?? m.recipe?.id
    const title = m.title ?? m.recipe?.title ?? 'a planned meal'
    if (!id) { unknownRecipes.push(title); continue }
    if (!seen.has(id)) {
      const r = await kitchen.call('my_recipe_get', { id }); toolCalls++
      seen.set(id, r.ok ? ((r.data as { recipe: { title: string; ingredients: { qty?: number; unit?: string; name: string }[] } }).recipe) : null)
    }
    const recipe = seen.get(id)
    if (!recipe) { unknownRecipes.push(title); continue }
    for (const ing of recipe.ingredients) {
      const have = pantryNames.find((p) => covers(p, ing.name))
      if (have) { alreadyHave.add(have); continue }
      const key = norm(ing.name)
      const need = byName.get(key) ?? { name: ing.name, forMeals: [] }
      if (ing.qty !== undefined && (need.unit === undefined || need.unit === ing.unit)) { need.qty = (need.qty ?? 0) + ing.qty; need.unit = ing.unit }
      if (!need.forMeals.includes(recipe.title)) need.forMeals.push(recipe.title)
      byName.set(key, need)
    }
  }
  return { from, to, needs: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), alreadyHave: [...alreadyHave], unknownRecipes: [...new Set(unknownRecipes)], toolCalls }
}
