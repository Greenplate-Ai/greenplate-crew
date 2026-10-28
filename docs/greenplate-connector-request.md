# Request to GreenplateAi: what Kitchen Crew needs from the connector

From: the Kitchen Crew build (Meta hackathon, due Nov 4 2026, 9 PM ET). Hand this to a GreenplateAi
session; the crew side is ready to plug in once these exist.

## Where the crew is today (2026-10-27)

- The crew app (iOS, TestFlight) talks to the crew service (home server), which reasons with Meta's
  Muse Spark and speaks with ElevenLabs. Conversation works end to end.
- Kitchen work goes through GreenplateAi's existing MCP endpoint (`https://mcp.greenplate.ai/mcp`) with
  one bearer token. There is no way yet for *another person* to connect their own kitchen, and no way
  for someone without GreenplateAi to try it.

## What we need, in order

### 1. A demo household (needed for judging - highest priority)

Judges and first-time users won't have GreenplateAi. We need one shared, sandboxed household:

- Seeded: ~25 pantry items with quantities, a 7-day meal plan (breakfast/lunch/dinner) using real
  recipes, a couple of logged meals.
- A long-lived token for it that the crew service holds (stored in Key Vault, never in the app).
- Read tools work normally. Writes either work but **reset nightly**, or are refused with a clear
  "demo kitchen is read-only" error. Either is fine; say which.
- Not counted against anyone's plan limits; or give it Pro.

### 2. "Sign in with GreenplateAi" for a native app

So each person's crew acts on their own kitchen:

- OAuth 2.1 Authorization Code + PKCE, public client "Kitchen Crew" (iOS), redirect via a custom
  scheme (`kitchencrew://auth`) or a universal link. Refresh tokens.
- The token's audience is the MCP endpoint. The app sends it to the crew service with each request;
  the crew service calls MCP on that person's behalf and does not store it.
- Same consent screen as the existing Claude connector is fine.

### 3. Scopes, so read and write are separate

- `kitchen:read` - `kitchen_pantry_list`, `kitchen_plan_list`, `kitchen_log_day`, `my_recipe_get`
- `kitchen:write` - `kitchen_pantry_add`, `kitchen_pantry_update`, `kitchen_plan_add`,
  `kitchen_plan_remove`, `kitchen_log_add`
- The crew already asks the person yes/no out loud before any write; scopes make that enforceable
  server-side too.

### 4. Machine-readable limits

The crew currently detects plan limits by matching the text "This needs GreenplateAi Plus" and
"You've reached today's limit". Please return a structured error (e.g. `code: "plan_required"` /
`"daily_limit"`) so the crew can say the right thing without string matching. A crew run targets
fewer than 40 tool calls (Plus allows 200/day).

## Acceptance (how we'll know it works)

1. The crew service, holding only the demo token, answers "what's in my pantry?" and "what's for
   dinner Thursday?" from the demo household.
2. A second person signs in on their own phone, and the crew reads *their* pantry, not the demo's.
3. A write without `kitchen:write` is refused by GreenplateAi, not just by the crew.

## Not needed

- No new kitchen tools; the existing ones cover the crew.
- No changes to how GreenplateAi stores data or to its own apps.
