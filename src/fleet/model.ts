// Meta Model API, OpenAI-compatible: https://api.meta.ai/v1, bearer MODEL_API_KEY.
import OpenAI from 'openai'

export const META_BASE_URL = 'https://api.meta.ai/v1'
export const MUSE_SPARK = 'muse-spark-1.3'

export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface Turn { text: string; toolCalls: ToolCall[]; inputTokens: number; outputTokens: number }

export type Msg =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

export interface Model {
  id: string
  /** US$ per million tokens; 0 until confirmed from Meta's pricing page. */
  price: { input: number; output: number }
  turn(messages: Msg[], tools: ToolDef[]): Promise<Turn>
}

/** How hard Muse Spark thinks before answering. 'minimal' measured 0.8 s vs 2.8 s default for a short spoken reply (2026-10-27). */
export type Effort = 'minimal' | 'low' | 'medium' | 'high'

export function museSpark(opts: { apiKey?: string; model?: string; baseURL?: string; effort?: Effort } = {}): Model {
  const apiKey = opts.apiKey ?? process.env.MODEL_API_KEY
  if (!apiKey) throw new Error('MODEL_API_KEY is not set')
  const client = new OpenAI({ baseURL: opts.baseURL ?? META_BASE_URL, apiKey })
  const model = opts.model ?? MUSE_SPARK
  return {
    id: model,
    price: { input: 0, output: 0 },
    async turn(messages, tools) {
      const started = Date.now()
      const res = await client.chat.completions.create({
        model,
        messages: messages.map(toWire),
        ...(opts.effort ? { reasoning_effort: opts.effort as 'low' } : {}),
        ...(tools.length ? { tools: tools.map((t) => ({ type: 'function' as const, function: t })) } : {}),
      })
      const m = res.choices[0]?.message
      console.log(`model ${opts.effort ?? 'default'} turn in ${Date.now() - started} ms (${tools.length} tools)`)
      return {
        text: m?.content ?? '',
        toolCalls: (m?.tool_calls ?? []).flatMap((c) => (c.type === 'function' ? [{ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) }] : [])),
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      }
    },
  }
}

function toWire(m: Msg): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
  if (m.role === 'assistant') {
    return m.toolCalls?.length
      ? { role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
      : { role: 'assistant', content: m.content }
  }
  return { role: m.role, content: m.content }
}

function parseArgs(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Plays back fixed turns: runs the crew with no key and no spend (tests, offline rehearsal). */
export function scripted(turns: Turn[], id = 'scripted'): Model {
  let i = 0
  return {
    id,
    price: { input: 1, output: 4 },
    async turn() {
      const t = turns[Math.min(i++, turns.length - 1)]
      if (!t) throw new Error('scripted: no turns')
      return t
    },
  }
}

export const say = (text: string): Turn => ({ text, toolCalls: [], inputTokens: 500, outputTokens: 50 })
export const call = (name: string, args: Record<string, unknown> = {}, id = `c-${name}`): Turn =>
  ({ text: '', toolCalls: [{ id, name, args }], inputTokens: 500, outputTokens: 30 })
