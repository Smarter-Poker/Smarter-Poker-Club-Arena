# 2026-08-26 — Code splitting TablePage: measured, then reverted

**Outcome: do not do this. The measurement is the deliverable.**

A proposal to "aggressively code split" `TablePage.tsx` claimed time-to-interactive
would "plummet" because users download the 3D replayer, the Bad Beat Jackpot modal
and the Mystery Bounty chest before they even sit down.

## Two of the premises were false

Checked, not assumed:

- **`HandReplay3D` (538 kB) is not pulled in by the table.** `TablePage.tsx` does
  not reference it anywhere. It is already a route-level chunk and loads only when
  its own route is visited.
- **`index.html` modulepreloads three files** — `vendor-react`, `vendor-supabase`,
  `HomePage`. `TablePage` is not preloaded either; it is fetched on navigation.

Nobody downloads the 3D replayer before sitting down, and TablePage's 470 kB was
never on the first-paint path.

## What splitting actually bought

Four components render from exactly one conditional branch each. Lazy-loaded:

```
TablePage-*.js   470,417 -> 462,499 bytes   -7,918  (-1.7%)

  KnockoutAnimation    3,995 B js  +  8,032 B css
  PineappleDiscard     2,383 B js  +  2,274 B css
  TimeBankStoreModal   2,214 B js  +  4,243 B css
  BBJHitNotification   1,616 B js  +  3,350 B css
```

Eight kilobytes. Not a plummet.

## Why it was reverted rather than kept

`CSS Beat E2E` went red on `live-animations.spec.ts:277` — "the KNOCKOUT: vignette,
shockwave, the head cracks and FALLS". It reads `koVignetteIn` from computed style
and got `undefined`, because `KnockoutAnimation.css` had moved into a chunk that
does not load until the component mounts.

That is not a test artefact. It is the feature:

- **KnockoutAnimation** and **BBJHitNotification** fire at the one dramatic moment
  that matters. If the stylesheet arrives with the chunk, the first knockout or
  jackpot of a session can render unstyled or late.
- **PineappleDiscard** appears mid-hand under an action timer. A network fetch at
  that instant can cost a player the hand.
- **TimeBankStoreModal** is the only genuinely safe one — user-initiated from a
  menu — and it is worth 2.2 kB of JS. That is not worth a Suspense boundary.

**The general rule this cost a red build to learn: a component that must appear
instantly and already styled is a bad lazy-loading candidate however conditional
its render is.** "Renders rarely" and "may arrive late" are different properties.

## What would actually move the number

The remaining weight is TablePage's own code — 126 static imports, ~15,000 lines.
Splitting cannot reach it. Decomposition can, and that is a larger piece of work
that has to be sequenced against the server-authoritative migration phase order in
CLAUDE.md section 3.
