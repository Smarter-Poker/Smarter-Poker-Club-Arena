# HANDOFF PROMPT — House Ads, Phase 2 (paste into a fresh chat)

**Written** 2026-08-27 22:10 UTC. **Every number below was queried at write time, not recalled.**

This is the _entry prompt_. The deep document it points at
(`.agent/handoffs/2026-08-27-house-ads-phase-2.md`, 344 lines, written by the agent who
built Phase 1) is the real briefing. This file exists so a fresh agent cannot start in the
wrong place, and to correct one dangerous piece of misinformation — see §0.

---

## 0. READ THIS FIRST — the trap that already caught one agent today

A survey agent working from a **stale worktree** concluded that the house-ads migrations
"do not exist as files", that there is "no admin API route", and that "the renderer is
unlocatable". **All three conclusions are wrong.** The worktree it read was behind `main`.

The truth, verified against `origin/main` at 2026-08-27 22:05 UTC:

| Claim from the stale survey | Reality                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------- |
| Migration files missing     | `supabase/migrations/20260827110000_house_ads.sql` is on `main` (PR #1478)            |
| No admin API route          | `pages/api/club-arena/house-ads.js` exists in the World Hub repo                      |
| Renderer unlocatable        | `src/services/AdService.ts` + `src/components/lobby/LobbyAdStrip.tsx`, both on `main` |
| No tests                    | `tests/unit/houseAds.test.ts`, 10 tests                                               |

**Therefore: your first command is `git fetch origin main` and your work starts from
`origin/main`, never from whatever a worktree happens to be sitting on.** If a claim in
any document contradicts `origin/main`, `origin/main` wins. Verify before you build.

---

## 1. THE PROMPT

> You are picking up **Phase 2 of the smarter.poker house ads system** in the Club Arena
> repo. Phase 1 is **shipped, merged and live in production — do not rebuild any of it.**
>
> **Required reading, in this order, before you write a single line of code:**
>
> 1. `AGENT-PLAYBOOK.md` (repo root) — how to ship without losing work.
> 2. `CLAUDE.md` (repo root) — binding house rules.
> 3. **`.agent/handoffs/2026-08-27-house-ads-phase-2.md`** — the real briefing: Dan's
>    binding rulings, the full data model, every file Phase 1 touched, the four unwired
>    slots, and the traps specific to this system. It is 344 lines and all of it matters.
> 4. This file's §0 above — do not repeat the stale-worktree mistake.
>
> **Ground truth, verified 2026-08-27 22:05 UTC (re-verify; do not trust these numbers blind):**
>
> ```
> ad_catalog      6 rows      the creative
> ad_placement    6 rows      all 6 on the ONE wired slot, lobby_strip
> ad_event       84 rows      84 impressions, 0 clicks, 0 dismisses, 3 distinct users
> slots wired     1 of 5
> ```
>
> **The objective.** Four of five declared slots are wired to nothing, and the World Hub
> has no ad surface at all. Extend the system to them **without touching the spine**:
>
> | slot                  | state     | note                                                                      |
> | --------------------- | --------- | ------------------------------------------------------------------------- |
> | `lobby_strip`         | LIVE      | Club Arena lobby. Leave it alone unless fixing a bug.                     |
> | `session_summary`     | not wired | after a session ends — high intent                                        |
> | `empty_state`         | not wired | empty lobby / no results — fills genuinely dead space                     |
> | `hub_promotions`      | not wired | **World Hub**, which has no ad surface whatsoever                         |
> | `table_between_hands` | not wired | **highest risk — read §5 of the deep handoff before going near the felt** |
>
> **Constraints that are not yours to re-litigate:**
>
> - **VIPs see ads.** Dan: _"even vips will see ads remove that for now."_ There is no VIP
>   suppression in `fn_resolve_ads` and a test pins that. Do not add it, and do not
>   re-advertise "Ad-Free" anywhere either.
> - **All targeting stays server-side in `fn_resolve_ads`.** The client must never decide
>   its own eligibility — the day a paying advertiser arrives, a browser-decided
>   impression is a billing dispute.
> - **HOUSE inventory sorts last and is styled quietest.** A club or union talking to its
>   own players outranks us talking to theirs. Preserve that ordering.
> - **Impressions de-duplicate per page load, not per render.** The strip rotates every 7s;
>   counting renders divides every campaign's CTR by a meaningless number.
> - **Admin API lives at `/api/club-arena/house-ads`, NOT `/api/admin/*`.** This is
>   deliberate — World Hub edge middleware demands an MFA cookie for non-GET under
>   `/api/admin/*` and the Club Arena SPA has no MFA flow, so it would authenticate fine
>   and then fail on every save. **Do not "fix" this.**
> - **No emoji in source.** Glyphs only (`◆ ◉ ★ ◈ ▣ ▲`). Emoji break the SWC compiler and
>   fail the Vercel build.
> - **Copy is Title Case and contains no em dashes** — the house popup rule.
>
> **The gap most worth closing first, and why.** `clicks = 0` against 84 impressions.
> Either the click path is not firing or nobody is clicking, and right now **you cannot
> tell which**. The whole justification for this system is that eleven promo surfaces
> shipped without anyone being able to answer "did anyone look at it" — shipping a second
> unanswerable question would be the same failure with better plumbing. Verify
> `AdService.logClick()` end-to-end against production before building new surfaces on top
> of a metric you have not proven works.
>
> **Definition of done for anything you ship:**
>
> - `npx vitest run tests/` **and** `cd server && npx vitest run src/` both green (there are
>   two suites; the second is easy to miss).
> - `npx tsc --noEmit` clean for the client and for `server/tsconfig.json`.
> - Any schema change is a real migration file committed to `supabase/migrations/`, applied
>   via the Supabase MCP, **and** the CI schema manifest refreshed
>   (`scripts/ci/supabase-schema-manifest.json`) — a stale manifest fails the branch with
>   "a migration in this branch declares something the live schema does not have".
> - A changelog entry in `docs/changelog/YYYY-MM-DD-<slug>.md` — **your own file**. Never
>   append to `MIGRATION-CHANGELOG.md`; it is frozen and was the single biggest source of
>   merge conflicts in this repo.
> - Shipped through a branch → PR → merge. Do not push to `main`.
>
> **Do not claim anything is deployed** until you have verified it from production —
> DB-visible behaviour or the deploy workflow's own version gate. "Pushed" is not
> "deployed", and the Hetzner deploy silently **coalesces** any run inside 20 minutes of
> the previous engine restart, reporting success while shipping nothing.
>
> Start by reading the four documents above, then re-verify the ground-truth numbers
> yourself, then tell me your plan before you build.

---

## 2. Session context the next agent should have

This session did **not** work on ads. It fixed two unrelated production outages, both now
merged and live. They are listed only so the next agent is not surprised by recent churn in
`server/` and does not mistake it for ad work:

| PR    | What                                                                                                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| #1461 | Every MTT, Spin and Heads-Up now takes the :55 synchronized break; the engine's park gate was unreachable from every idle branch |
| #1470 | A break forbids the next hand; hand-for-hand still gets its one more (caught before it could deadlock a money bubble)            |
| #1473 | The live 18:55 verification recorded                                                                                             |
| #1505 | The held-empty hold rotates — it was a life sentence that had killed **every Spin and Heads-Up on the platform** for 20 hours    |

#1505 is worth two minutes of the next agent's time as a **cautionary pattern**, because it
is the same shape of bug the ads system could grow: a deterministic per-id hash used as a
permanent flag, combined with a "this slot is already covered" rule, produced an absorbing
state that silently killed a whole product surface — and **every refusal on that path
returned 0 silently**, so nothing reported it for twenty hours. `ad_placement.daily_cap`
and the `seenThisLoad` de-dupe are the same class of mechanism. If you add a cap or a hold
to ads, make sure it **rotates**, and make sure a suppressed ad is **countable**.

---

## 3. Known-stale copy the deep handoff claims was cleaned (verify)

The Phase 1 migration header states the "Ad-Free Experience" line _"has been removed from
every VIP surface"_. Re-check these in the **World Hub** repo against `origin/main` before
trusting it — a stale survey found them still present, but that survey was reading an old
tree and was wrong about everything else:

- `src/config/vip-feature-matrix.js` (two occurrences)
- `src/lib/geevesKB/trainingAndDiamonds.js`
- `pages/api/cron/vip-lapse.js` (header comment)
- `src/data/diamondStoreData.js` — its comment justifies the removal with _"there is no ad
  system in either repo"_, which stopped being true at 19:11 UTC on 2026-08-27.
