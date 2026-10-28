// Kitchen mode: as food comes out of the fridge or cupboard, the crew names it once and keeps the list.
// Packaged food is read by its barcode on the phone (free: no model call); a photo goes to the model
// only when the person asks or the barcode is unknown ("Hey Crew, I've got this"). Nothing is written to GreenplateAi here.

import { spokenList } from './vision.js'

export interface Session { items: string[]; seen: Set<string>; pantry: string[]; at: number }

/** Barcode -> product name from Open Food Facts (free, no key). Cached for the life of the process. */
export function barcodeLookup(f: typeof fetch = fetch) {
  const cache = new Map<string, Promise<string | null>>()
  return (code: string): Promise<string | null> => {
    if (!/^\d{6,14}$/.test(code)) return Promise.resolve(null)
    let hit = cache.get(code)
    if (!hit) {
      hit = f(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands`, {
        headers: { 'user-agent': 'GreenplateAi-KitchenCrew/0.1 (greenplate.ai)' },
        signal: AbortSignal.timeout(4000),
      }).then(async (r) => {
        if (!r.ok) return null
        const p = ((await r.json()) as { product?: { product_name?: string; brands?: string } }).product
        const name = p?.product_name?.trim()
        return name ? shortName(name, p?.brands) : null
      }).catch(() => null)
      hit.then((n) => { if (n === null) cache.delete(code) }) // unknown or offline: try again next time
      cache.set(code, hit)
    }
    return hit
  }
}

/** "Nature's Own Keto Burger Buns 8 ct" -> "Nature's Own keto burger buns": brand kept, sizes dropped. */
export function shortName(name: string, brands?: string): string {
  const brand = brands?.split(',')[0]?.trim()
  let n = name.replace(/\b\d+(\.\d+)?\s?(oz|ct|g|kg|lb|ml|l|fl oz|count|pack)\b.*$/i, '').trim()
  if (brand && !n.toLowerCase().includes(brand.toLowerCase())) n = `${brand} ${n}`
  return n.slice(0, 60)
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\b(the|a|an|of)\b/g, '').replace(/\s+/g, ' ').trim()

/** The pantry entry this item probably is, if any (shares a meaningful word with it). */
export function inPantry(item: string, pantry: string[]): string | undefined {
  const words = new Set(norm(item).split(' ').filter((w) => w.length > 3))
  return pantry.find((p) => norm(p).split(' ').some((w) => w.length > 3 && words.has(w)))
}

/** Adds the item once; returns what to say, or null when it was already counted. */
export function takeOut(s: Session, item: string): string | null {
  const key = norm(item)
  if (!key || s.seen.has(key)) return null
  s.seen.add(key)
  s.items.push(item)
  return `Got ${item}.`
}

/** What was pulled out, said once at the end; notes what the pantry list doesn't have yet. */
export function summary(s: Session): string {
  if (!s.items.length) return 'Nothing came out this time.'
  const missing = s.items.filter((i) => !inPantry(i, s.pantry))
  const said = `You pulled out ${spokenList(s.items)}.`
  return missing.length ? `${said} Not on your pantry list yet: ${spokenList(missing)}.` : said
}
