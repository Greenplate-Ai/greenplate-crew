import { describe, expect, it } from 'vitest'
import { fakeKitchen } from '../src/kitchen.js'
import { buildShoppingList, covers } from '../src/shopping.js'

describe('covers', () => {
  it('matches plurals and descriptive words', () => {
    expect(covers('eggs', 'large egg')).toBe(true)
    expect(covers('Baby spinach', 'spinach')).toBe(true)
    expect(covers('chicken thighs', 'boneless chicken thigh')).toBe(true)
    expect(covers('rice', 'brown rice')).toBe(true)
  })
  it('does not match different foods that share a word', () => {
    expect(covers('chicken stock', 'chicken thigh')).toBe(false)
    expect(covers('green onion', 'green pepper')).toBe(false)
  })
})

describe('buildShoppingList', () => {
  const kitchen = () => fakeKitchen({
    pantry: [{ name: 'eggs' }, { name: 'brown rice' }],
    plan: [
      { date: '2026-10-27', slot: 'dinner', recipeId: 'r1', title: 'Fried rice' },
      { date: '2026-10-28', slot: 'dinner', recipeId: 'r1', title: 'Fried rice' },
      { date: '2026-10-29', slot: 'dinner', recipeId: 'cat-9', title: 'Catalog curry' },
    ],
    recipes: { r1: { title: 'Fried rice', servings: 2, ingredients: [{ qty: 2, name: 'egg' }, { qty: 1, unit: 'cup', name: 'rice' }, { qty: 2, name: 'green onions' }, { qty: 1, unit: 'tbsp', name: 'soy sauce' }] } },
  })

  it('lists what is missing and skips what is home', async () => {
    const list = await buildShoppingList(kitchen(), '2026-10-27', '2026-11-02')
    expect(list.needs.map((n) => n.name)).toEqual(['green onions', 'soy sauce'])
    expect(list.alreadyHave.sort()).toEqual(['brown rice', 'eggs'])
  })

  it('adds up amounts when a recipe is planned twice', async () => {
    const list = await buildShoppingList(kitchen(), '2026-10-27', '2026-11-02')
    expect(list.needs.find((n) => n.name === 'green onions')?.qty).toBe(4)
  })

  it('reads each recipe once and says which ones it could not open', async () => {
    const k = kitchen()
    const list = await buildShoppingList(k, '2026-10-27', '2026-11-02')
    expect(k.calls.filter((c) => c === 'my_recipe_get')).toHaveLength(2)
    expect(list.unknownRecipes).toEqual(['Catalog curry'])
    expect(list.toolCalls).toBe(4)
  })
})
