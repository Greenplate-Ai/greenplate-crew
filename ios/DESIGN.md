# Kitchen Crew UI handoff

Source of truth for the look: the design canvas https://claude.ai/artifact/A9bLBdWexdU4Y8uPkeG5AM
(artboards Ask, Approve, Shopping, Connect, plus the store listing and three screenshots).
Built on GreenplateAi's own tokens (core repo: `sites/ventures/greenplateai/design/export/greenplateai-v2/tokens/ds`).

## Tokens (put in `Crew/Theme.swift`)

| Name | Hex | Use |
|---|---|---|
| green | #25A777 | primary buttons, mic button, progress fill |
| greenDeep | #186F50 | green text on light (small text must use this, not green) |
| forest | #0E2B1F | glasses status bar, onboarding hero, lead agent dot |
| leaf | #4ECB37 | accents on forest only (voice meter, live dot, timer) |
| tint | #D9F2E7 | your chat bubble, agent dots |
| tint50 | #F3FAF6 | agent chips, icon tiles |
| ink | #202428 | body text |
| muted | #585E6A | secondary text |
| line | #E2DFDA | card borders |
| shell | #EDEAE5 | progress track, inactive step |
| canvas | #FBFAF9 | screen background |
| forestText | #B9D6C6 | secondary text on forest |
| warn | #8A3B2E on #FCF7F6, border #E3D9D9 | "Already at home", End trip |

Type: Inter (or SF Pro if Inter is not bundled) for UI. Newsreader 500 only for the onboarding headline.
Radii: cards 18, inner boxes 14, buttons and chips fully round (capsule). Shadow: soft and green-tinted,
`0 4 20 -8 rgba(32,36,40,.1)`; the approval card uses `0 22 44 -26 rgba(26,50,20,.28)`.
Touch targets at least 44 pt.

## Screens

**1. Ask (home)** replaces today's `List` in `ContentView`.
- Header: small forest tile with the bowl mark, "Kitchen Crew" 20 semibold, round settings button.
- `GlassesBar` (the signature piece): forest card, glasses glyph, title + subtitle, leaf voice meter on the right.
  States: "Oakley Meta connected / Listening for "crew"", "Waiting for your answer / Say yes or no" (leaf timer pill),
  "Watching what you pick up / Frames are checked, then dropped" (shopping), "Not connected" (tap opens Connect).
- Conversation: your bubble right-aligned on tint, corner 18/18/6/18. Crew answer is a white card with agent chips
  ("Shopper", "Pantry keeper") and "worked at the same time" when the run fanned out.
- "What the crew did": rows of agent dot (letter) + plain-words step + seconds. Lead dot is forest, others tint.
  Needs the service to return friendly step text (see below).
- Bottom: "Start a shopping trip" outline capsule, then the input capsule with a green mic button.

**2. Approve** is a state of Ask, not a new screen.
- Approval card: 1.5 pt green border, "The planner wants to change your plan", a before/after box
  (old row muted with strikethrough, new row in greenDeep), two capsules "Yes, move it" / "No",
  note "Nothing changes until you answer. No answer in 20 seconds counts as no."

**3. Shopping** is a pushed screen while a trip is active.
- Header "Shopping trip" + "For this week's five dinners", warn-colored "End trip" capsule.
- GlassesBar in shopping state with the last spoken line in a translucent box.
- "2 of 5 in the cart" + progress bar.
- List card: checked rows (green check circle, strikethrough, "seen 2 min ago"), open rows (empty circle, quantity),
  pantry rows on the warn tint with a house icon and "Already at home".
- Footer hint: Say "Hey Crew, check out" at the register.

**4. Connect** is shown until the glasses are registered and connected.
- Forest hero with glasses line art and "Glasses found nearby".
- Newsreader headline "Put your crew on your glasses", three numbered steps (done / current / next),
  green "Register with Meta AI", text link "Try it on the phone first".

Settings stays a sheet (address + app token) restyled with the same cards.

## What the code needs for this

- `Theme.swift` with the tokens above; `GlassesBar`, `ChatBubble`, `CrewAnswerCard`, `StepRow`,
  `ApprovalCard`, `ShoppingRow`, `CapsuleButton` views.
- `CrewModel` exposes: glasses state for the bar; per-answer agent names and whether they ran in parallel;
  shopping list items with status (needed / checked with time / at home); the pending change as before/after.
- Service changes (`src/kitchen/server.ts`): return `agents` and `parallel` per run; `steps` as plain words
  (for example "Pantry keeper checked 42 items") with seconds; approvals as `{who, before, after}` alongside `spoken`;
  `/shopping/start` returns quantities and pantry matches, `/frame` returns the item it checked.

## Build run plan (next session)

1. Add the repo to Codemagic (Zach) and run `crew-ios-testflight` once as-is to get compile errors.
2. Fix compile errors until it builds.
3. Restyle to this handoff, screen by screen, in this order: Theme + GlassesBar, Ask, Approve, Shopping, Connect.
4. Service changes above, with tests, then one more TestFlight build.
