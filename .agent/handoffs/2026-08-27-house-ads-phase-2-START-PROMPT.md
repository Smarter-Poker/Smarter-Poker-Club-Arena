# START PROMPT — House Ads, Phase 2

Paste the block below into a fresh agent session. It is deliberately short: the
full brief is `.agent/handoffs/2026-08-27-house-ads-phase-2.md` on `main`, and
the first instruction is to read it.

Written 2026-08-27 by the Cowork agent that finished the Bad Beat Jackpot work,
after verifying every state claim below against production and GitHub rather
than against memory or a local worktree.

---

## Why this file exists beside the phase-2 handoff

Two things a fresh agent will otherwise get wrong on day one:

1. **The local World Hub worktrees are STALE.** A search of
   `~/Documents/.agent-trees/Smarter-Poker-World-Hub/cowork` reports that
   `pages/api/club-arena/house-ads.js` does not exist, and concludes the admin
   panel is a dead end with no write path. That conclusion is WRONG. The file is
   on Hub `main` (16,214 bytes, verified via the GitHub API tonight). Trust
   `main`, not the checkout in front of you.
2. **Head SHAs in the phase-2 handoff are already historical.** It records CA
   `main` at `3924dc8708`; several PRs have merged since. Re-read the tips
   yourself instead of assuming that document's snapshot.

---

## The prompt

```
You are picking up HOUSE ADS PHASE 2 on smarter.poker. Phase 1 is SHIPPED,
MERGED and LIVE. Do not rebuild it.

STEP 0 - ORIENT BEFORE YOU TOUCH ANYTHING.
Read, in this order, and do not write code until you have:
  1. AGENT-PLAYBOOK.md            (how to ship without losing work)
  2. CLAUDE.md                    (repo law - especially 11.5 and 12)
  3. .agent/handoffs/2026-08-27-house-ads-phase-2.md
     ^ THIS IS YOUR BRIEF. 344 lines. Everything below is a summary of it.

WORK IN YOUR OWN WORKTREE, branched from current origin/main. Never push to
main. Never rebase main. Commit as
  Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>
or Vercel refuses to build the commit.

VERIFY THE GROUND BEFORE TRUSTING ANY DOCUMENT, including this one:
  - the local World Hub worktree is stale; pages/api/club-arena/house-ads.js
    DOES exist on Hub main - check GitHub, not the checkout
  - re-read the current head SHAs of both repos yourself

WHAT EXISTS (all live in production, project kuklfnapbkmacvwxktbh):
  tables   ad_catalog (6), ad_placement (6), ad_event (impressions/clicks)
  resolver public.fn_resolve_ads(p_slot, p_club_id, p_limit)
           STABLE SECURITY DEFINER - ALL targeting lives here, never in the client
  RLS      no write policy at all on catalog/placement; ad_event is
           insert-your-own-row-only, no SELECT
  client   src/services/AdService.ts, src/components/lobby/LobbyAdStrip.tsx
  admin    src/pages/admin/HouseAdsPage.tsx -> /api/club-arena/house-ads
  tests    tests/unit/houseAds.test.ts  (keep green)
  migration supabase/migrations/20260827110000_house_ads.sql

DAN'S BINDING RULINGS - DO NOT RE-LITIGATE:
  - "even vips will see ads" - NO VIP suppression anywhere, and do not
    re-advertise an ad-free tier. A test pins both directions.
  - Zero paid advertisers: the space promotes OUR features. The plumbing stays
    advertiser-shaped so nothing is rebuilt when a real one arrives.
  - Never PKO + mystery bounty. Do not write ad copy implying it exists.
  - Horses are players. Never exclude them from a count, report or payout.

BUILD, IN PRIORITY ORDER (four of five slots are declared but unwired):
  P1  hub_promotions      - the World Hub has NO ad surface at all. Highest value.
  P2  session_summary and empty_state
  P3  reporting the admin panel cannot answer yet: CTR over time, per-club,
      per-slot. The event rows already exist; nothing reads them that way.
  P4  table_between_hands - HIGHEST RISK. An ad near live money or a live
      decision is the one that can hurt a player. Read section 5 of the brief
      before writing a line of it.
  Adding a SIXTH slot needs a migration altering the CHECK constraint. Never
  widen it ad hoc.

FOUR TRAPS THAT HAVE ALREADY COST TIME:
  1. Never let the client decide eligibility. If you are filtering ads in
     TypeScript, you have put the browser in charge of what a future advertiser
     is billed for. Targeting belongs in fn_resolve_ads.
  2. Impressions de-duplicate PER PAGE LOAD, not per render. The strip rotates
     every 7 seconds; counting renders divides every campaign's click-through
     rate by a meaningless number.
  3. stats === null means "could not count", not "zero". Render '-', never 0.
  4. Every target_url must resolve. A promo that opens a 404 is worse than an
     empty slot. Click it before you ship it.

HOW TO SHIP - you do this yourself, start to finish:
  - migrations ONLY via the Supabase MCP apply_migration (never raw
    execute_sql for DDL), then REFRESH THE SCHEMA MANIFEST in the same PR:
    node scripts/ci/gen-schema-manifest.mjs   (needs SUPABASE_URL and
    SUPABASE_SERVICE_ROLE_KEY; they are in ~/Documents/club-arena/.env)
    CI fails the PR otherwise, and it is right to.
  - green before pushing: npx tsc --noEmit, npx vitest run tests/,
    and the server suite if you touched server/
  - never push a red test. A failing test does not fail a report here - it
    stops the World Hub sync for every agent until a human notices.
  - branch -> PR -> autopilot squash-merges when checks pass.
  - DO NOT claim it is deployed until you have fetched the bytes from
    production and found your change in them. "Merged" is not "published".
    curl https://smarter.poker/api/health          -> the SHA being served
    then grep your own marker string out of the deployed chunk under
    https://smarter.poker/hub/club-arena/assets/
  - never ask a human to push, merge or deploy. Never run vercel deploy.
    Never create a new repo, Vercel project or Supabase project.

FINISH BY: writing your own changelog at docs/changelog/YYYY-MM-DD-<slug>.md
(your OWN file - never append to MIGRATION-CHANGELOG.md, it is frozen), and
leaving the next agent a handoff as honest as the one you were given: what you
shipped, what you found, what you deliberately did not do, and why.
```
