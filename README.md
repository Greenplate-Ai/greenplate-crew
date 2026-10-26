# GreenplateAi Crew

**A fleet of trusted AI agents you command from Meta glasses, deployed first as GreenplateAi's
kitchen crew.**

Built by GreenplateAi for the **Meta Global AI Developer Hackathon** (Oct 26 - Nov 4, 2026),
Startup track, problem statement **Build for Your World**.

## Two parts, kept separate

| | What it is | Where |
|---|---|---|
| **The fleet** (the technical product) | A lead agent that hands work to specialists, in parallel when a request needs several; per-agent tool permissions; approval before sensitive changes; per-run turn, call and cost budgets; the service's own plan limits respected; an answer guard; a run log of every step. It contains no kitchen logic. | `src/fleet/` |
| **The kitchen crew** (the first deployment) | Six agents (lead, shopper, pantry keeper, planner, logger, chef) doing kitchen work inside a household's real GreenplateAi data, called by voice from Meta glasses, with modes for shopping, saving recipes, cooking, eating out and pantry checks. | `src/kitchen/` |

The engine is tested on a fleet that has nothing to do with food (`test/fleet.test.ts`).

## What existed before, and what was built this week

| Existed before the hackathon (not in this repo) | Built during the hackathon (this repo) |
|---|---|
| GreenplateAi: the web app at app.greenplate.ai, its API, database and recipe catalog | The fleet engine (`src/fleet/`) |
| GreenplateAi's MCP plug-in with pantry, plan, food-log and recipe tools | The kitchen crew, its modes, and its shopping list (planned recipes minus pantry), `src/kitchen/` |
| | The glasses companion app for iPhone (Meta Wearables Device Access Toolkit) |
| | The live fleet view used in the demo |

Any change made to GreenplateAi itself during the event (for example, a new plug-in tool) is listed
here when it lands. The demo video opens with the same split.

## Meta models used

- **Muse Spark 1.3** (Meta Model API): every agent's reasoning, tool calls and parallel hand-offs.
- **SAM 3.1**: finding each item in a wide glasses frame (receipts, plates).
- **Muse Voice Transcribe 1.0**: "hey crew" requests and spoken answers' inputs.
- **Muse Spark Open** (open weights, via a partner): one specialist agent.

## Where the line is

The kitchen crew does kitchen work: plan, shop, stock, cook and log. It never gives health, diet or
medical advice and never tells anyone what to eat. That rule lives in one place,
`src/kitchen/noadvice.ts`, which checks every spoken answer and rewrites or replaces one that
drifts. Nutrition targets are numbers the person set; the crew records and plans around them and
never comments on them. Anything read from a photo is saved as an estimate.

## Fits GreenplateAi's plans

The crew runs inside the household's own GreenplateAi tier, through the same plug-in limits as any
other client: Free sees suggestions only, Plus lets the crew save its work within the daily limit,
Pro is the all-day crew on glasses.

## Run it

```
npm install
npm test                                    # 17 tests, no keys needed
npm run ask -- shopping "what am I missing?"  # live: needs MODEL_API_KEY and GREENPLATE_MCP_TOKEN
```

License: MIT, GreenplateAi LLC.
