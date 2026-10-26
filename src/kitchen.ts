// The household's kitchen in GreenplateAi, reached through GreenplateAi's existing MCP plug-in.
// Every call acts only on the signed-in household and passes GreenplateAi's own plan limits.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export interface ToolResult { ok: boolean; text: string; data: unknown }

export interface Kitchen {
  call(tool: string, args?: Record<string, unknown>): Promise<ToolResult>
}

/** GreenplateAi's own refusals ("This needs GreenplateAi Plus.", "You've reached today's limit."). */
export const LIMIT_WORDS = ['This needs GreenplateAi Plus', "You've reached today's limit"]
export const isLimit = (r: ToolResult): boolean => !r.ok && LIMIT_WORDS.some((w) => r.text.includes(w))

export async function connectKitchen(opts: { url?: string; token?: string } = {}): Promise<Kitchen & { close(): Promise<void> }> {
  const url = opts.url ?? process.env.GREENPLATE_MCP_URL ?? 'https://mcp.greenplate.ai/mcp'
  const token = opts.token ?? process.env.GREENPLATE_MCP_TOKEN
  if (!token) throw new Error('GREENPLATE_MCP_TOKEN is not set')
  const client = new Client({ name: 'greenplate-crew', version: '0.1.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return {
    async call(tool, args = {}) {
      const r = await client.callTool({ name: tool, arguments: args })
      const content = Array.isArray(r.content) ? r.content : []
      const text = content.flatMap((c) => (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? [c.text] : [])).join('\n')
      let data: unknown = null
      try { data = JSON.parse(text) } catch { data = null }
      return { ok: r.isError !== true, text, data }
    },
    close: () => client.close(),
  }
}

/** An in-memory kitchen with GreenplateAi's tool names and shapes, for tests and offline rehearsal. */
export function fakeKitchen(state: {
  pantry?: { name: string; quantity?: number; unit?: string; expires?: string }[]
  plan?: { date: string; slot: string; recipeId: string; title: string; servings?: number }[]
  recipes?: Record<string, { title: string; servings: number; ingredients: { qty?: number; unit?: string; name: string }[] }>
  limitAfter?: number
}): Kitchen & { calls: string[] } {
  const calls: string[] = []
  const ok = (data: unknown): ToolResult => ({ ok: true, text: JSON.stringify(data), data })
  return {
    calls,
    async call(tool, args = {}) {
      calls.push(tool)
      if (state.limitAfter !== undefined && calls.length > state.limitAfter) return { ok: false, text: "You've reached today's limit.", data: null }
      switch (tool) {
        case 'kitchen_pantry_list': return ok({ items: state.pantry ?? [] })
        case 'kitchen_plan_list': return ok({ items: (state.plan ?? []).filter((p) => p.date >= String(args.from) && p.date <= String(args.to)) })
        case 'my_recipe_get': {
          const r = state.recipes?.[String(args.id)]
          return r ? ok({ recipe: { id: args.id, ...r } }) : { ok: false, text: 'No recipe of yours has that id.', data: null }
        }
        case 'kitchen_pantry_add': {
          state.pantry = [...(state.pantry ?? []), { name: String(args.name), quantity: args.quantity as number | undefined, unit: args.unit as string | undefined }]
          return ok({ item: args })
        }
        default: return { ok: false, text: `fakeKitchen: ${tool} not modelled`, data: null }
      }
    },
  }
}
