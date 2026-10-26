// The crew does kitchen work; it never coaches. This catches a spoken answer that drifts into
// telling someone how to eat, judging a meal, or health talk, so the lead can rewrite it as facts.
const PATTERNS: RegExp[] = [
  /\byou should (eat|have|try|cut|avoid|limit|reduce|skip)\b/i,
  /\b(cut back|cut down|eat (less|more|better)|healthier|unhealthy|too much (sugar|fat|salt|sodium|carbs?))\b/i,
  /\b(lose|losing|gain|gaining) weight\b/i,
  /\b(diet|dieting|calorie deficit|nutrition(al)? advice|wellness)\b/i,
  /\b(good|bad|great|poor) (choice|option) for (you|your health)\b/i,
  /\b(doctor|medical|blood sugar|cholesterol|diabet\w*|blood pressure)\b/i,
]

export function soundsLikeCoaching(text: string): string | null {
  for (const p of PATTERNS) {
    const m = text.match(p)
    if (m) return m[0]
  }
  return null
}

export const REWRITE = 'Rewrite your answer as plain kitchen facts: what was planned, bought, stocked, used or logged. Do not tell the person what to eat, judge any food, or mention health, weight or diet. Keep it to one or two short sentences.'
