// The kitchen deployment's service: GreenplateAi's existing MCP plug-in (pre-existing, not part of
// this repo). Every call acts only on the signed-in household and passes GreenplateAi's own plan limits.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Service, ServiceResult } from '../fleet/runtime.js'

export interface KitchenResult extends ServiceResult { data: unknown }
export interface Kitchen extends Service { call(tool: string, args?: Record<string, unknown>): Promise<KitchenResult> }

/** GreenplateAi's own refusals when a plan does not include a tool or the day's limit is used. */
export const LIMIT_WORDS = ['This needs GreenplateAi Plus', "You've reached today's limit"]
const isLimit = (ok: boolean, text: string): boolean => !ok && LIMIT_WORDS.some((w) => text.includes(w))

/** token: a fixed bearer token, or a function that returns a fresh one (a signed-in person's session). */
export async function connectKitchen(opts: { url?: string; token?: string | (() => Promise<string>) } = {}): Promise<Kitchen & { close(): Promise<void> }> {
  const url = opts.url ?? process.env.GREENPLATE_MCP_URL ?? 'https://mcp.greenplate.ai/mcp'
  const token = opts.token ?? process.env.GREENPLATE_MCP_TOKEN
  if (!token) throw new Error('GREENPLATE_MCP_TOKEN is not set')
  const bearer = typeof token === 'string' ? async () => token : token
  const authed: typeof fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${await bearer()}`)
    return fetch(input, { ...init, headers })
  }
  const client = new Client({ name: 'greenplate-crew', version: '0.1.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: authed }))
  return {
    async call(tool, args = {}) {
      const r = await client.callTool({ name: tool, arguments: args })
      const content = Array.isArray(r.content) ? r.content : []
      const text = content.flatMap((c) => (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? [c.text] : [])).join('\n')
      let data: unknown = null
      try { data = JSON.parse(text) } catch { data = null }
      const ok = r.isError !== true
      return { ok, text, data, limit: isLimit(ok, text) }
    },
    close: () => client.close(),
  }
}

/** An in-memory kitchen with GreenplateAi's tool names and shapes, for tests and offline rehearsal. */
export function fakeKitchen(state: {
  pantry?: { id?: string; name: string; quantity?: number; unit?: string; expires?: string }[]
  grocery?: { id?: string; name: string; ticked?: boolean }[]
  plan?: { date: string; slot: string; recipeId: string; title: string; servings?: number }[]
  recipes?: Record<string, { title: string; servings: number; ingredients: { qty?: number; unit?: string; name: string }[] }>
  log?: { date: string; slot: string; items: { name?: string }[] }[]
  favourites?: string[]
  limitAfter?: number
}): Kitchen & { calls: string[] } {
  const calls: string[] = []
  const ok = (data: unknown): KitchenResult => ({ ok: true, text: JSON.stringify(data), data })
  const no = (text: string): KitchenResult => ({ ok: false, text, data: null, limit: isLimit(false, text) })
  return {
    calls,
    async call(tool, args = {}) {
      calls.push(tool)
      if (state.limitAfter !== undefined && calls.length > state.limitAfter) return no("You've reached today's limit.")
      switch (tool) {
        case 'kitchen_pantry_list': return ok({ items: (state.pantry ?? []).map((p, i) => ({ id: p.id ?? `p${i}`, ...p })) })
        case 'kitchen_grocery_list': return ok({ items: (state.grocery ?? []).map((g, i) => ({ id: g.id ?? `g${i}`, ticked: false, ...g })), fromPlan: [] })
        case 'kitchen_grocery_add': {
          state.grocery = [...(state.grocery ?? []), { id: `g${(state.grocery ?? []).length}`, name: String(args.name) }]
          return ok({ item: args })
        }
        case 'kitchen_grocery_update': case 'kitchen_grocery_remove': case 'kitchen_pantry_remove': {
          const list = tool === 'kitchen_pantry_remove' ? state.pantry ?? [] : state.grocery ?? []
          const i = list.findIndex((r, n) => (r.id ?? `${tool === 'kitchen_pantry_remove' ? 'p' : 'g'}${n}`) === args.id)
          if (i < 0) return no('No item of yours has that id.')
          if (tool === 'kitchen_grocery_update') (list[i] as { ticked?: boolean }).ticked = args.ticked === true
          else list.splice(i, 1)
          return ok({ removed: tool !== 'kitchen_grocery_update' })
        }
        case 'kitchen_plan_list': return ok({ items: (state.plan ?? []).map((p, n) => ({ id: `m${n}`, ...p })).filter((p) => p.date >= String(args.from) && p.date <= String(args.to)) })
        case 'my_recipe_get': {
          const r = state.recipes?.[String(args.id)]
          return r ? ok({ recipe: { id: args.id, ...r } }) : no('No recipe of yours has that id.')
        }
        case 'kitchen_pantry_update': {
          const i = (state.pantry ?? []).findIndex((r, n) => (r.id ?? `p${n}`) === args.id)
          if (i < 0) return no('No item of yours has that id.')
          Object.assign(state.pantry![i]!, args.quantity !== undefined ? { quantity: Number(args.quantity) } : {}, args.unit ? { unit: String(args.unit) } : {})
          return ok({ item: state.pantry![i] })
        }
        case 'kitchen_pantry_add': {
          state.pantry = [...(state.pantry ?? []), { name: String(args.name), quantity: args.quantity as number | undefined, unit: args.unit as string | undefined }]
          return ok({ item: args })
        }
        case 'kitchen_plan_add': {
          const r = state.recipes?.[String(args.recipeId)]
          state.plan = [...(state.plan ?? []), { date: String(args.date), slot: String(args.slot), recipeId: String(args.recipeId), title: String(args.title ?? r?.title ?? '') }]
          return ok({ item: args })
        }
        case 'kitchen_plan_remove': {
          const i = (state.plan ?? []).findIndex((p, n) => ((p as { id?: string }).id ?? `m${n}`) === args.id)
          if (i < 0) return no('No planned meal of yours has that id.')
          state.plan!.splice(i, 1)
          return ok({ removed: true })
        }
        case 'kitchen_log_day': return ok({ meals: (state.log ?? []).filter((m) => m.date === args.date) })
        case 'kitchen_log_add': {
          state.log = [...(state.log ?? []), { date: String(args.date), slot: String(args.slot), items: (args.items as { name?: string }[] | undefined) ?? [] }]
          return ok({ logged: args })
        }
        case 'my_recipes_list': return ok({ recipes: Object.entries(state.recipes ?? {}).map(([id, r]) => ({ id, title: r.title })) })
        case 'my_collections_list': return ok({ collections: [{ id: 'favourites', name: 'Favourites', recipeIds: state.favourites ?? [] }] })
        case 'my_collection_add': {
          state.favourites = [...(state.favourites ?? []), String(args.recipeId)]
          return ok({ added: args })
        }
        default: return no(`fakeKitchen: ${tool} not modelled`)
      }
    },
  }
}
