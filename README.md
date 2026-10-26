# GreenplateAi Crew

**Your kitchen has a crew. Call any of them from your Meta glasses.**

A small team of AI agents, built on Meta's models, that does the work of running a household's
kitchen inside GreenplateAi: what to buy, what is about to go off, saving recipes, cooking, and
keeping the household's records right. You call them by voice from Meta glasses, wherever you are
in your day.

Built by GreenplateAi for the **Meta Global AI Developer Hackathon** (Oct 26 - Nov 4, 2026),
Startup track, problem statement **Build for Your World**.

## What existed before, and what was built this week

| Existed before the hackathon (not in this repo) | Built during the hackathon (this repo) |
|---|---|
| GreenplateAi: the web app at app.greenplate.ai, its API, database and recipe catalog | The crew: a lead agent and specialist agents on Muse Spark |
| GreenplateAi's MCP plug-in with pantry, plan, food-log and recipe tools | The crew runtime: hand-offs, per-run call and cost budgets, approval before changing the plan, a step-by-step run log |
| | Modes (shopping, capture, cooking, eating out, pantry check) |
| | The shopping list (planned recipes minus pantry), computed here |
| | The glasses companion app for iPhone (Meta Wearables Device Access Toolkit) |

This file is updated as each piece lands. The demo video opens with the same split.

## Meta models used

- **Muse Spark 1.3** (Meta Model API): every agent's reasoning and tool calls.
- **SAM 3.1**: finding each item in a wide glasses frame (receipts, plates).
- **Muse Voice Transcribe 1.0**: "hey crew" requests and spoken corrections.
- **Muse Spark Open** (open weights, via a partner): one specialist agent.

## Fits GreenplateAi's plans

The crew runs inside the household's own GreenplateAi tier, through the same plug-in limits as
any other client: Free sees suggestions only, Plus lets the crew save its work within the daily
limit, Pro is the all-day crew on glasses.

## What the crew never does

No health, diet or medical advice. Nutrition targets are numbers the person set; the crew plans
and records around them and never tells anyone how to eat. Anything read from a photo is saved
as an estimate.

## Run it

```
npm install
npm test
```

Live runs need `MODEL_API_KEY` (Meta Model API) and `GREENPLATE_MCP_TOKEN` (a GreenplateAi
sign-in for the household). See `.env.example`.

License: MIT.
