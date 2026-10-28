// Live shopping: name the grocery item in a glasses frame with Muse Spark's vision, then check it
// against the household's shopping list and pantry. Frames are processed and dropped, never stored.
import OpenAI from 'openai'
import { META_BASE_URL, MUSE_SPARK } from '../fleet/model.js'
import { covers, type ShoppingList } from './shopping.js'

export interface Seen { item: string | null; confidence: number }

/** Asks Muse Spark what single grocery item is being held up or put in the cart. */
export function museSparkEyes(opts: { apiKey?: string; model?: string } = {}): (jpegBase64: string) => Promise<Seen> {
  const apiKey = opts.apiKey ?? process.env.MODEL_API_KEY
  if (!apiKey) throw new Error('MODEL_API_KEY is not set')
  const client = new OpenAI({ baseURL: META_BASE_URL, apiKey })
  return async (jpegBase64) => {
    const res = await client.chat.completions.create({
      model: opts.model ?? MUSE_SPARK,
      messages: [
        { role: 'system', content: 'You look at one frame from smart glasses in a grocery store. Name the single grocery product the wearer is holding or putting in a cart, as a short generic name (for example "green onions", "soy sauce", "eggs"). Ignore people, shelves and anything not in hand or cart. Reply as JSON: {"item": string or null, "confidence": number from 0 to 1}.' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } }] },
      ],
      response_format: { type: 'json_object' },
    })
    try {
      const v = JSON.parse(res.choices[0]?.message?.content ?? '{}') as Partial<Seen>
      return { item: typeof v.item === 'string' && v.item.trim() ? v.item.trim() : null, confidence: typeof v.confidence === 'number' ? v.confidence : 0 }
    } catch {
      return { item: null, confidence: 0 }
    }
  }
}

export interface ShoppingTrip { list: ShoppingList; pantry: string[]; checked: Set<string>; announced: Set<string> }

/** What to say about an item just seen, or nothing. Says each thing once per trip. */
export function noticeItem(trip: ShoppingTrip, seen: Seen, minConfidence = 0.6): string | null {
  if (!seen.item || seen.confidence < minConfidence) return null
  const item = seen.item
  if ([...trip.announced].some((a) => covers(a, item) || covers(item, a))) return null

  const need = trip.list.needs.find((n) => covers(item, n.name) || covers(n.name, item))
  if (need) {
    trip.checked.add(need.name)
    trip.announced.add(item)
    const left = trip.list.needs.filter((n) => !trip.checked.has(n.name)).map((n) => n.name)
    return left.length ? `${need.name}, checked off. Still need ${left.slice(0, 3).join(', ')}${left.length > 3 ? ', and more' : ''}.` : `${need.name}, checked off. That's everything on the list.`
  }
  const home = trip.pantry.find((p) => covers(p, item) || covers(item, p))
  if (home) {
    trip.announced.add(item)
    return `You already have ${home} at home.`
  }
  trip.announced.add(item)
  return `${item} isn't on the list. I'll add it to the pantry when you're home.`
}

/** The last reminder before checkout. */
export function remaining(trip: ShoppingTrip): string {
  const left = trip.list.needs.filter((n) => !trip.checked.has(n.name)).map((n) => n.name)
  return left.length ? `Before you check out: you still need ${left.join(', ')}.` : 'You have everything on the list.'
}

// ── Logging a meal from a photo ───────────────────────────────────────────────────────────────

export interface PlateItem { name: string; portion?: string }

/** Asks Muse Spark what foods are on the plate in front of the wearer. Names only, no numbers. */
export function museSparkPlate(opts: { apiKey?: string; model?: string } = {}): (jpegBase64: string) => Promise<PlateItem[]> {
  const apiKey = opts.apiKey ?? process.env.MODEL_API_KEY
  if (!apiKey) throw new Error('MODEL_API_KEY is not set')
  const client = new OpenAI({ baseURL: META_BASE_URL, apiKey })
  return async (jpegBase64) => {
    const res = await client.chat.completions.create({
      model: opts.model ?? MUSE_SPARK,
      messages: [
        { role: 'system', content: 'You look at one frame from smart glasses while the wearer eats. List the foods and drinks in front of them as short everyday names (for example "grilled chicken", "white rice", "iced tea"), with a rough portion if you can tell (for example "1 cup", "1 burger"). Only what is clearly food in front of them. Reply as JSON: {"items": [{"name": string, "portion": string or null}]}; an empty list if you cannot tell.' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } }] },
      ],
      response_format: { type: 'json_object' },
    })
    return plateItems(res.choices[0]?.message?.content ?? '{}')
  }
}

/** The model's JSON as clean items (at most 12, GreenplateAi's limit for one meal). */
export function plateItems(json: string): PlateItem[] {
  try {
    const v = JSON.parse(json) as { items?: { name?: unknown; portion?: unknown }[] }
    return (v.items ?? []).flatMap((i) => {
      const name = typeof i.name === 'string' ? i.name.trim().slice(0, 200) : ''
      const portion = typeof i.portion === 'string' && i.portion.trim() ? i.portion.trim().slice(0, 60) : undefined
      return name ? [portion ? { name, portion } : { name }] : []
    }).slice(0, 12)
  } catch { return [] }
}

/** "chicken, rice and broccoli" */
export function spokenList(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
