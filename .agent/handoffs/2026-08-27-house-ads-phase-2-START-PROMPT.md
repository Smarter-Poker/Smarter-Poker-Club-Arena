# START PROMPT — House Ads, Phase 2

Written 2026-08-27 by the Cowork agent that shipped Bad Beat Jackpot phases 5
and 6. Every number and file path below was verified against production and the
GitHub API tonight, not recalled.

Paste the block between the fences into a fresh agent session. It is
self-contained: an agent with zero context can start work from it alone. The
344-line deep brief is `.agent/handoffs/2026-08-27-house-ads-phase-2.md`, and
the prompt tells them to read it — but it does not depend on it.

---

```
You are picking up HOUSE ADS PHASE 2 on smarter.poker (Club Arena + World Hub).
Read this whole prompt before you touch anything. It tells you what exists, what
is broken, what to build, and how to ship it yourself end to end.

═══════════════════════════════════════════════════════════════════════════
1. WHAT THIS PROJECT IS, AND WHY
═══════════════════════════════════════════════════════════════════════════

smarter.poker has ZERO paid advertisers. Dan's ruling: the ad space promotes our
own features. So this is a house-promotion system built with advertiser-shaped
plumbing, so that nothing has to be rebuilt when a real advertiser arrives.

THE REASON IT EXISTS, in one sentence: eleven promotional surfaces already
shipped in this product and NOT ONE of them ever recorded an impression or a
click, so nobody could answer "did anyone even look at it". The event log is the
product. Everything you build must preserve that answer.

═══════════════════════════════════════════════════════════════════════════
2. WHAT IS ALREADY BUILT AND LIVE  (Phase 1 - DO NOT REBUILD IT)
═══════════════════════════════════════════════════════════════════════════

DATABASE (Supabase project kuklfnapbkmacvwxktbh, all applied to production):

  ad_catalog    the creative
      id, ad_key, category, headline, body, glyph, target_url, cta_label,
      is_active, starts_at, ends_at, weight, created_by, created_at, updated_at
  ad_placement  where it runs and to whom
      id, ad_id, slot, club_id, audience, daily_cap, is_active, created_at
  ad_event      impressions / clicks / dismisses   <- THE POINT OF THE SYSTEM
      id, ad_id, user_id, slot, event_type, club_id, created_at
      indexes: idx_ad_event_rollup, idx_ad_event_cap

  RESOLVER: public.fn_resolve_ads(p_slot text, p_club_id uuid DEFAULT NULL,
                                  p_limit int DEFAULT 3)
      STABLE SECURITY DEFINER, search_path = public, pg_temp,
      granted to anon + authenticated.
      Returns (ad_id, ad_key, category, headline, body, glyph, target_url,
               cta_label).
      ALL targeting lives here on purpose: audience (all / non_vip / vip /
      new_player / returning), club scoping, start/end windows, weight order,
      and a per-user 24h daily_cap. The client must never disagree with the
      server about who is eligible.

  RLS: ad_catalog and ad_placement have a SELECT policy and NO WRITE POLICY AT
       ALL - every browser write is refused no matter what any API route does.
       ad_event permits INSERT of your own row only (user_id = auth.uid()) and
       has no SELECT, so one player can never enumerate another's history.

  Migration of record (matches production byte for byte):
       supabase/migrations/20260827110000_house_ads.sql   [Club Arena repo]

CODE - Club Arena (~/Documents/club-arena, deploys THROUGH the World Hub):
  src/services/AdService.ts .................. resolve, logImpression, logClick,
                                               logDismiss, logEvent
  src/components/lobby/LobbyAdStrip.tsx/.css . the ONLY live render surface
  src/pages/admin/HouseAdsPage.tsx ........... admin panel, route /house-ads,
                                               registered in src/App.tsx and
                                               components/navigation/HamburgerMenu.tsx
  src/services/clubArenaApi.ts ............... extended with method + query
  tests/unit/houseAds.test.ts ................ 10 source-pinned tests. KEEP GREEN.

CODE - World Hub (~/Documents/Smarter-Poker-World-Hub):
  pages/api/club-arena/house-ads.js .......... GET (catalog + rollups) / POST /
                                               PATCH / DELETE, gated on
                                               profiles.role IN ('admin','super_admin')

  !! THE LOCAL WORLD HUB WORKTREES ON THIS MACHINE ARE STALE. They will tell
     you house-ads.js does not exist and that the admin panel has no write
     path. THAT IS FALSE - the file is on Hub main, 16,214 bytes, verified via
     the GitHub API on 2026-08-27. Trust main, not the checkout in front of you.

  !! DO NOT "FIX" the route by moving it to /api/admin/*. Hub edge middleware
     demands an MFA session cookie for any non-GET under /api/admin/*, and the
     Club Arena SPA has no MFA flow - the panel would authenticate fine and then
     be refused at the edge on EVERY save. The route authorises itself instead,
     more strictly than club admin, because house ads run in every club's lobby.

SLOTS - five declared in the ad_placement CHECK constraint, ONE wired:
  lobby_strip .......... DECLARED + WIRED + LIVE   (Club Arena lobby)
  hub_promotions ....... declared, NOT wired       (World Hub has no ad surface)
  session_summary ...... declared, NOT wired
  empty_state .......... declared, NOT wired
  table_between_hands .. declared, NOT wired       (highest risk - see 5)
  A SIXTH slot requires a migration altering the CHECK constraint. Never widen
  it ad hoc.

THE SIX LIVE CAMPAIGNS (all on lobby_strip, all clubs), with real impression
counts as of 2026-08-27 22:04 UTC:

  ad_key             weight  audience  cap  target_url     impressions
  vip_upsell            120  non_vip    3   /vip                     0   <-- !!
  spins_jackpot         110  all        -   /                       30
  bbj_running           100  all        -   /                       19
  referral_invite        85  all        -   /invite                 15
  tournaments_daily      80  all        -   /tournaments            12
  diamonds_store         90  all        3   /cashier                 8

  TOTALS: 84 impressions, 0 clicks, 0 dismisses.

═══════════════════════════════════════════════════════════════════════════
3. START HERE - TWO THINGS IN THAT TABLE ARE PROBABLY BUGS
═══════════════════════════════════════════════════════════════════════════

Do these BEFORE building anything new. New slots multiply whatever is wrong.

P0-A. ZERO CLICKS ACROSS 84 IMPRESSIONS, AND ZERO DISMISSES.
      Could be honest (a quiet grey house rail nobody taps). Could equally be
      that click logging never lands. Suspect, in order:
        - LobbyAdStrip.handleActivate() logs the click and then navigates; if
          the insert is not awaited or the page unloads first, the row is lost.
          Consider navigator.sendBeacon or awaiting before navigation.
        - ad_event INSERT requires user_id = auth.uid() under RLS. An anonymous
          or not-yet-resolved session cannot insert AT ALL - impressions from
          logged-out viewers would silently vanish too.
        - is a dismiss control even rendered? If not, 0 dismisses is not a bug,
          and you should say so rather than "fixing" it.
      PROVE which it is. A rolled-back transaction or a local click with the
      network tab open is evidence; reasoning is not.

P0-B. vip_upsell HAS THE HIGHEST WEIGHT (120) AND ZERO IMPRESSIONS.
      Every other campaign has served. It is the only one with audience
      'non_vip'. Either the audience predicate in fn_resolve_ads never matches
      (bug), or every viewer so far has been VIP (fine, and easy to confirm
      against profiles). Confirm which. If the predicate is wrong, every future
      audience-targeted campaign is wrong with it.

Also note: spins_jackpot and bbj_running both point at "/" - not a deep link,
just the lobby. The house rule is that every target_url resolves to something
specific. Worth raising with Dan or repointing.

═══════════════════════════════════════════════════════════════════════════
4. WHAT TO BUILD, IN PRIORITY ORDER
═══════════════════════════════════════════════════════════════════════════

P1 - hub_promotions: give the World Hub an ad surface.       HIGHEST VALUE
     The Hub has NO ad surface at all. The slot and resolver already exist.
     The Hub is Next.js pages-router and does NOT share Club Arena's services -
     DO NOT import across repos. Either call fn_resolve_ads through the Hub's
     own Supabase client or add a thin GET route. Either way, log through the
     SAME ad_event table so both surfaces are comparable in one place.
     DONE = a Hub page renders a house promo, an impression row appears with
     slot='hub_promotions', and a click on it logs a click row.

P2 - session_summary and empty_state.
     Same AdService, new mount points. empty_state pairs with the Club Arena
     lobby's existing empty view - genuinely dead space, honest to fill.
     DONE = rows in ad_event carrying those slot values, from a real render.

P3 - Reporting the admin panel cannot answer yet.
     HouseAdsPage shows impressions/clicks/dismisses per ad, and nothing else.
     It cannot show CTR over time, per-club breakdown, or which slot performed
     better. All the data is already in ad_event and both indexes exist. Read
     only, low risk, high operator value.
     DONE = an operator can answer "which slot converts best" without SQL.

P4 - table_between_hands.        HIGHEST RISK - READ SECTION 5 FIRST.

SOCIAL is in scope too (Dan: "social media is all social media references pages
etc"). Four verified, still-unfixed defects, each read in the file:
  1. club-arena/src/components/social/ReferralDashboard.tsx:82-99 - shares the
     BARE homepage; the referral code sits only in `text` and is lost on any
     target that ignores it. A real attribution leak. The other two referral
     flows embed the code in the URL correctly.
  2. Hub src/components/ui/InviteFriendsModal.jsx:116-210 - social buttons use
     native URI schemes (fb://, twitter://, tg://, instagram://, whatsapp://,
     reddit://) with NO web fallback, despite a comment claiming there is one.
     Silently dead on desktop.
  3. club-arena/index.html:31-49 - one static set of OG/Twitter tags, so every
     shared deep link (including ShareHand's replay URLs) previews as a generic
     "Club Arena - Private Online Poker Clubs". Proper fix needs server-rendered
     per-route OG tags.
  4. Hub pages/_document.js:57 - declares og:image:height 2151 for a 1200-wide
     image while SEOHead.js declares 1200x630 for the SAME og-default.png. One
     is wrong; check the actual file.
  5. No official social accounts exist in either repo. The only handle anywhere
     is @SmarterPoker in Twitter card meta. If real accounts exist, GET THE
     HANDLES FROM DAN - do not invent them.

═══════════════════════════════════════════════════════════════════════════
5. TRAPS THAT HAVE ALREADY COST TIME
═══════════════════════════════════════════════════════════════════════════

- table_between_hands is the one that can hurt players. An ad rendered near a
  live decision or live money is not a design question, it is a fairness one.
  Nothing may overlap action controls, steal a tap, or animate during a hand.
- NEVER let the client compute eligibility. If you are filtering ads in
  TypeScript you have put the browser in charge of what a future advertiser is
  billed for. Targeting belongs in fn_resolve_ads.
- Impressions de-duplicate PER PAGE LOAD, not per render (AdService keeps a
  seenThisLoad Set). The strip rotates every 7 seconds; counting renders divides
  every campaign's click-through rate by a meaningless number. Preserve this.
- stats === null means "could not count", NOT zero. Render '-', never 0. A
  fabricated zero on a metrics surface is a lie an operator will act on.
- HOUSE sorts LAST and is styled quietest (grey rail,
  .lobby-ads__strip--house). A club or union talking to its own players outranks
  us talking to theirs. Do not promote house inventory above CLUB or UNION.
- Every target_url must resolve. A promo that opens a 404 is worse than an empty
  slot. Click it before you ship it.

═══════════════════════════════════════════════════════════════════════════
6. DAN'S BINDING RULINGS - DO NOT RE-LITIGATE
═══════════════════════════════════════════════════════════════════════════

- "even vips will see ads remove that for now" - NO VIP suppression anywhere,
  and do not re-advertise an ad-free tier. The "Ad-Free Experience" claim was
  removed from the Diamond Store, the VIP feature matrix (x2), the Geeves
  knowledge base and a cron comment. houseAds.test.ts pins BOTH directions.
- Zero paid advertisers: the space promotes OUR features, with advertiser-shaped
  plumbing.
- Never PKO + mystery bounty. Do not write ad copy implying it exists.
- HORSES ARE PLAYERS (CLAUDE.md 10.5, hard law). They are never excluded by
  design from any count, report, payout, rule or timing. If you write `is_horse`
  to leave a horse OUT of something a human gets, you are writing a bug.
- No emoji in source. Popup/toast text is Title Cased with no em dashes.
- Never call the horses "bots".

═══════════════════════════════════════════════════════════════════════════
7. HOW YOU SHIP - YOURSELF, START TO FINISH
═══════════════════════════════════════════════════════════════════════════

Read first: AGENT-PLAYBOOK.md, then CLAUDE.md (especially 10.5, 11.5, 12), then
.agent/handoffs/2026-08-27-house-ads-phase-2.md for the full brief.

  - Your OWN worktree, branched from current origin/main. NEVER push to main.
    NEVER rebase main (a pre-rebase hook refuses it and it strands the clone).
  - Commit as: Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>
    Any other author and Vercel BLOCKS the deployment with no build log at all.
  - Migrations ONLY via the Supabase MCP apply_migration - never raw execute_sql
    for DDL - AND refresh the schema manifest in the SAME PR:
        node scripts/ci/gen-schema-manifest.mjs
        (needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, both in
         ~/Documents/club-arena/.env)
    CI fails the PR otherwise, and it is right to. This cost me a red build today.
  - Never probe a money path against production. Roll it back. (CLAUDE.md 11.5 -
    an agent once destroyed 48 real chips proving a guard worked.)
  - Green before you push: npx tsc --noEmit, npx vitest run tests/, and the
    server suite if you touched server/. NEVER push a red test: the vitest run
    in build-for-world-hub.yml is what PUBLISHES the bundle, so a red test stops
    the deploy for every agent until a human notices.
  - branch -> PR -> autopilot squash-merges when checks pass. Do not merge by
    hand unless it stalls.
  - DO NOT CLAIM IT IS DEPLOYED until you have pulled the bytes from production
    and found your own change in them. "Merged" is not "published":
        curl -s https://smarter.poker/api/health        # the SHA being served
        then grep a marker string of yours out of the deployed chunk under
        https://smarter.poker/hub/club-arena/assets/
    (Club Arena publishes through the World Hub: CA main -> build-for-world-hub
     -> a "chore(club-arena): sync build <sha>" commit on the Hub -> Vercel.
     Allow roughly 10 minutes end to end.)
  - Never ask a human to push, merge or deploy. Never run vercel deploy or touch
    a deploy hook. Never create a new repo, Vercel project or Supabase project.

FINISH BY: writing your OWN changelog at docs/changelog/YYYY-MM-DD-<slug>.md -
never append to MIGRATION-CHANGELOG.md, it is frozen and it was the single
biggest source of merge conflicts in this repo - and leaving the next agent a
handoff as honest as this one: what you shipped, what you found, what you
deliberately did NOT do, and why.

═══════════════════════════════════════════════════════════════════════════
8. REPO STATE WHEN THIS WAS WRITTEN (2026-08-27 ~22:15 UTC)
═══════════════════════════════════════════════════════════════════════════

  Club Arena main ..... f12e623a97 (moves fast - several agents ship here)
  World Hub main ...... 4f8db6bd+, serving sync commit 50c11376
  Production .......... healthy, deploys flowing, verified serving tonight
  ad_event ............ 84 rows, all impressions, newest 22:04:54 UTC
  Open PR ............. #1515 (docs only, this file)

  JUST SHIPPED BY THE PREVIOUS AGENT, unrelated to ads but touching the same
  repo - do not be surprised by it: Bad Beat Jackpot phases 5 and 6 (PR #1500,
  merged and verified live). Added src/utils/handFormat.ts (money/blindLabel/
  stamp/gameTypeLabel - USE IT rather than writing another money formatter),
  made fn_bbj_recent_hits pageable, added bbj_hand_evidence_log, and fixed a
  crash plus four stuck states across the BBJ surface. See
  docs/changelog/2026-08-27-bbj-phase5-and-6.md.
```
