# HANDOFF — House Ads, Phase 2

**Written** 2026-08-27 by the Cowork agent that built Phase 1.
**For** any agent picking this up in a fresh session with zero context.
**Status of Phase 1: SHIPPED, MERGED, LIVE IN PRODUCTION. Do not rebuild it.**

---

## 0. THE ONE-PARAGRAPH BRIEF

smarter.poker has no paid advertisers, so Dan's ruling is that the ad space
promotes our own features. Phase 1 built the whole spine — creative catalog,
placement/targeting, an impression/click event log, a server-side resolver, a
staff-only admin panel, and one live surface (the Club Arena lobby strip). It is
running now and has already logged **76 real ad events**. Phase 2 is extending it
to the surfaces that are declared but not yet wired, and to the World Hub and
social, which have no ad surface at all.

**The reason this project exists, in one sentence:** eleven promotional surfaces
already shipped in this product and **not one of them recorded an impression or a
click**, so nobody could answer "did anyone look at it". Everything you build
must preserve that answer.

---

## 1. DAN'S BINDING RULINGS — DO NOT RE-LITIGATE

| Ruling                     | Exact words                                                                                          | What it means for you                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VIPs see ads               | _"even vips will see ads remove that for now"_                                                       | **NO VIP suppression anywhere.** `fn_resolve_ads` deliberately has no VIP exclusion. A test pins this. The "Ad-Free Experience" claim was removed from the Diamond Store, the VIP feature matrix (×2), the Geeves KB and a cron comment. **Do not restore it in either direction** — do not add suppression, and do not re-advertise ad-free. |
| No paid ads yet            | _"SINCE WE HAVE ZERO PAID ADS WE SHOULD BE PROMOTING OUR OWN FEATURES AND CONTENTS IN THE AD SPACE"_ | Everything is house inventory. The plumbing is deliberately advertiser-shaped so nothing is rebuilt when a real advertiser arrives.                                                                                                                                                                                                           |
| Social scope               | _"social media is all social media references pages etc"_                                            | Phase 2 includes social. See §6 — there is real, verified work there and some of it is currently broken.                                                                                                                                                                                                                                      |
| Never PKO + mystery bounty | _"no, never pko+mystery bounty ever"_                                                                | Unrelated to ads but binding platform-wide; do not create ad copy implying that combination exists.                                                                                                                                                                                                                                           |

---

## 2. WHAT ALREADY EXISTS — READ BEFORE WRITING ANY CODE

### 2.1 Database (applied to production, project `kuklfnapbkmacvwxktbh`)

Three tables and one resolver. All live.

```
ad_catalog     6 rows   the creative
ad_placement   6 rows   where it runs + to whom
ad_event      76 rows   impressions / clicks / dismisses  ← the point of the system
```

`public.fn_resolve_ads(p_slot text, p_club_id uuid DEFAULT NULL, p_limit int DEFAULT 3)`
— `STABLE SECURITY DEFINER`, `search_path = public, pg_temp`, granted to `anon`
and `authenticated`. Returns `(ad_id, ad_key, category, headline, body, glyph,
target_url, cta_label)`.

**All targeting lives in this function**, deliberately: the client cannot
disagree with the server about eligibility, and a future paying advertiser is
never billed for impressions a browser decided to serve itself. It handles
audience (`all` / `non_vip` / `vip` / `new_player` / `returning`), club scoping,
start/end windows, weight ordering, and a per-user 24h `daily_cap`.

**RLS:** `ad_catalog` and `ad_placement` have a SELECT policy and **no write
policy at all** — every browser write is refused regardless of any API route.
`ad_event` allows INSERT of your own row only (`user_id = auth.uid()`) and no
SELECT, so one player can never enumerate another's viewing history.

Migration of record (matches production byte-for-byte — I diffed the function
body, policies, all six campaigns and their caps):
`supabase/migrations/20260827110000_house_ads.sql` on CA `main`.

### 2.2 Slots — declared vs actually wired

The `ad_placement.slot` CHECK constraint already permits five slots. **Only one
is wired.** This is the single biggest lever in Phase 2:

| slot                  | declared | wired       | notes                                                 |
| --------------------- | -------- | ----------- | ----------------------------------------------------- |
| `lobby_strip`         | ✅       | ✅ **LIVE** | Club Arena lobby. All 6 campaigns run here.           |
| `session_summary`     | ✅       | ❌          | After a session ends. High intent moment.             |
| `empty_state`         | ✅       | ❌          | Empty lobby / no results. Fills genuinely dead space. |
| `hub_promotions`      | ✅       | ❌          | **World Hub** — currently has NO ad surface at all.   |
| `table_between_hands` | ✅       | ❌          | Highest-risk. See §5 warning.                         |

Adding a slot beyond these five requires altering the CHECK constraint — do that
in a migration, not by widening it ad hoc.

### 2.3 Code — file by file

**Club Arena** (`~/Documents/club-arena`, deploys via World Hub):

- `src/services/AdService.ts` — `resolve()`, `logImpression()`, `logClick()`,
  `logDismiss()`, `logEvent()`. Impressions de-duplicate per **page load** via a
  `seenThisLoad` Set, **not per render** — the strip rotates every 7s and
  counting renders would divide every campaign's click-through rate by a
  meaningless number. Preserve this.
- `src/components/lobby/LobbyAdStrip.tsx` — `source: 'CLUB' | 'UNION' | 'HOUSE'`.
  **HOUSE sorts LAST and is styled quietest** (grey rail, `.lobby-ads__strip--house`).
  A club or union talking to its own players outranks us talking to theirs.
  `handleActivate()` logs the click **before** navigating away.
- `src/components/lobby/LobbyAdStrip.css` — house styling.
- `src/pages/admin/HouseAdsPage.tsx` — the admin UI, route `/house-ads`,
  registered in `src/App.tsx` and `src/components/navigation/HamburgerMenu.tsx`.
  Fails closed on an unreadable role. Renders `'-'` and not `0` when stats are
  unreadable.
- `src/services/clubArenaApi.ts` — extended with `method` (POST/GET/PATCH/DELETE)
  and `query`; GET/DELETE send no body.
- `tests/unit/houseAds.test.ts` — 10 source-pinned tests. **Keep them green.**

**World Hub** (`~/Documents/Smarter-Poker-World-Hub`):

- `pages/api/club-arena/house-ads.js` — GET (catalog + rollups) / POST / PATCH /
  DELETE. Gated on `profiles.role IN ('admin','super_admin')`.

### 2.4 Why the admin API is under `/api/club-arena` and NOT `/api/admin`

**Do not "fix" this.** World Hub edge middleware requires an MFA session cookie
for any non-GET under `/api/admin/*`. The Club Arena SPA has no MFA flow, so an
admin screen there would authenticate perfectly and then be refused at the edge
on **every save**. The route authorizes itself instead, and more strictly than
club admin — house ads run in _every_ club's lobby, so a club owner may write
their own announcements but only smarter.poker staff may put a message in
someone else's room. RLS is the second lock.

### 2.5 The six live campaigns

`vip_upsell` (weight 120, audience `non_vip`, cap 3/day), `spins_jackpot` (110),
`bbj_running` (100), `diamonds_store` (90, cap 3/day), `referral_invite` (85),
`tournaments_daily` (80). Every one deep-links to a route that **exists** — a
promo that opens a 404 is worse than an empty slot. Verify any new campaign's
`target_url` resolves before shipping it.

---

## 3. PHASE 2 — WHAT TO BUILD, IN PRIORITY ORDER

### P1 — `hub_promotions`: give the World Hub an ad surface (highest value)

The World Hub has **no ad surface whatsoever**. The slot is already declared and
the resolver already works. You need a Hub-side equivalent of `AdService` +
a strip/card component, then placements pointing at it.

The Hub is Next.js pages-router and does **not** share Club Arena's TypeScript
services — do not import across repos. Either call `fn_resolve_ads` through the
Hub's own Supabase client, or add a thin GET route. Whichever you choose, the
event logging must stay server-truthful: log through the same `ad_event` table
so the two surfaces are comparable in one place.

### P2 — `session_summary` and `empty_state`

Both are declared, both are honest places for a house promo (an empty lobby is
genuinely dead space). Same `AdService`, new mount points. `empty_state` pairs
naturally with the Club Arena lobby's existing empty view.

### P3 — Reporting the admin panel cannot yet answer

`HouseAdsPage` shows impressions/clicks/dismisses per ad. It cannot yet show
**CTR over time**, per-club breakdown, or which slot performed better. All the
data is in `ad_event` (`ad_id, user_id, slot, event_type, club_id, created_at`)
and the indexes are already there (`idx_ad_event_rollup`, `idx_ad_event_cap`).
This is a read-only feature — low risk, high operator value.

### P4 — `table_between_hands`

Declared, deliberately unwired. **Read §5 before touching it.**

---

## 4. HOUSE RULES THAT WILL BITE YOU (learned the hard way this session)

These are not style preferences. Each corresponds to a real incident.

1. **WORK IN YOUR OWN WORKTREE.** Never edit the shared clone. I violated this
   once and had to `git checkout --` to restore it.

   ```bash
   cd ~/Documents/club-arena
   git worktree add -b feat/your-branch .agent-trees/<yourname>/w origin/main
   ```

   `scripts/agent-workspace.sh` exists but places worktrees outside the
   Cowork-connected folders; creating it manually under `.agent-trees/` inside
   the repo is what actually works.

2. **NEVER PUSH A RED TEST.** `npx vitest run tests/` in `build-for-world-hub.yml`
   is what PUBLISHES the bundle. A red test stops the World Hub sync for every
   agent. If you deliberately replace behaviour a test pins, **update that test
   in the same commit** and say why.

3. **`tests/` IS NOT THE WHOLE SUITE.** There is a second suite under
   `server/src/**/*.test.ts`. I ran `npx vitest run tests/`, thought I was green,
   and CI caught five failures I had not run. For anything under `server/`:

   ```bash
   cd server && npx vitest run
   ```

4. **`node --check` IS BLIND.** It passes on files that are genuinely
   unparseable. The pre-push hook uses Babel with `sourceType:'module'` + `jsx`,
   which is why it caught a stray `}` that froze production for ~15 minutes
   today. To reproduce the hook's check exactly, use
   `scripts/hooks/pre-push-js-safety.sh`'s Babel invocation, not `node -c`.

5. **A NEW DB OBJECT MEANS A MANIFEST REFRESH.** `check-migrations-applied.mjs`
   and `check-phantom-tables.mjs` compare against
   `scripts/ci/supabase-schema-manifest.json`. Add your new tables/functions
   there **in the same PR**, or CI's "TypeScript Check" job fails with a message
   that has nothing to do with TypeScript. Reproduce CI exactly with:

   ```bash
   GITHUB_BASE_REF=main node scripts/ci/check-migrations-applied.mjs
   ```

6. **NO EMOJI IN SOURCE.** Breaks the SWC compiler. Use glyphs (`◆ ◉ ★ ◈ ▣ ▲`),
   which is what the seed campaigns do. The admin API strips emoji from
   submitted copy rather than rejecting the save.

7. **POPUPS: Title Case, no em dashes.** Enforced centrally in
   `src/utils/popupStyle.ts`. Never bypass the Toast layer.

8. **NEVER PROBE A MONEY PATH AGAINST PRODUCTION.** Roll back in a transaction.
   See `CLAUDE.md` §11.5. Ads do not move money today — if Phase 2 ever adds a
   paid placement, this becomes the most important rule on the page.

9. **Commit author must be** `Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>`
   or Vercel refuses to build the commit with no logs at all.

10. **Never call AI players "bots".** They are horses.

---

## 5. TRAPS SPECIFIC TO THIS SYSTEM

**`table_between_hands` is the one that can hurt players.** An ad rendered near
the felt competes with the game itself. Before wiring it: it must never overlap
action controls, never appear mid-hand, and never delay a deal. If in doubt,
leave it unwired and ask Dan — an unused declared slot costs nothing.

**Do not let the client compute eligibility.** If you find yourself filtering ads
in JavaScript, stop: that logic belongs in `fn_resolve_ads`. The whole design
depends on the server being the only authority.

**Impressions must stay honest.** Per page load, not per render; and log the
click _before_ navigating. If a number in the admin panel cannot be trusted,
the system is worth less than nothing because it will be used to make decisions.

**`stats === null` means "could not count", not "zero".** The API returns `null`
on a failed rollup read and the panel prints `'-'`. Preserve that distinction — a
confident zero reads as "nobody clicked" when the truth is "we could not count",
which is the exact class of lie previous audits kept finding here.

---

## 6. SOCIAL — Dan's answer, and what is actually broken there

Dan clarified scope as _"all social media references pages etc"_. I audited both
repos and **verified each of these by reading the file**. None are fixed.

1. **`club-arena/src/components/social/ReferralDashboard.tsx:82-99`** —
   `navigator.share({ url: 'https://smarter.poker' })` passes the **bare
   homepage**; the referral code lives only in the `text` field, so it is lost
   entirely on any share target that ignores `text`. The other two referral flows
   (`InviteFriendsModal.jsx`, `ReferralModal.tsx`) correctly embed the code in
   the URL. **This is a real attribution leak.**

2. **`Smarter-Poker-World-Hub/src/components/ui/InviteFriendsModal.jsx:116-210`**
   — social buttons use native app URI schemes (`fb://`, `twitter://`, `tg://`,
   `instagram://`, `whatsapp://`, `reddit://`) with **no web fallback**, despite a
   comment at :116-117 claiming _"Falls back to browser if app not installed"_.
   On desktop, or without the app, these fail silently.

3. **`club-arena/index.html:31-49`** — the SPA has one static set of OG/Twitter
   tags, so **every** shared deep link — including `ShareHand.tsx`'s hand-replay
   URLs — previews as a generic "Club Arena — Private Online Poker Clubs".
   Fixing this properly needs server-rendered per-route OG tags, which is a
   real piece of work and a good Phase 2 candidate given the ad/growth framing.

4. **`Smarter-Poker-World-Hub/pages/_document.js:57`** — declares
   `og:image:height` of **2151** for a 1200-wide image, while
   `SEOHead.js` correctly declares 1200×630 for the _same_ `og-default.png`.
   One of the two is wrong; check the actual file dimensions.

5. **No official social accounts exist in either repo.** The only handle anywhere
   is `@SmarterPoker` in Twitter card meta (`_document.js:61`,
   `vendor/commander-shared/src/components/seo/SEOHead.js:22`). There is no
   "Follow Us" surface and no footer social links. **If those accounts exist,
   you must get the handles from Dan — do not invent them.**

---

## 7. HOW TO SHIP

```bash
# 1. Your own worktree, branched from current main
cd ~/Documents/club-arena
git worktree add -b feat/ads-phase2 .agent-trees/<you>/w origin/main
cd .agent-trees/<you>/w

# 2. Build. Apply any migration via the Supabase MCP `apply_migration`
#    (never raw execute_sql for DDL), and refresh the schema manifest.

# 3. Verify — ALL of these
npx tsc --noEmit
npx vitest run tests/
cd server && npx vitest run && cd ..          # if you touched server/
GITHUB_BASE_REF=main node scripts/ci/check-migrations-applied.mjs
node scripts/ci/check-phantom-tables.mjs

# 4. Commit as Smarter-Poker, push a branch, open a PR.
#    Autopilot squash-merges when checks pass. Never push to main directly.
```

**Do not** ask a human to push, merge or deploy. **Do not** run `vercel deploy`.
**Do not** create new repos, Vercel projects or Supabase projects (RULE 12).

Verification standard: production serving your SHA via `/api/health`. For engine
changes, verify through the database (a hand-rate dip in `hand_history` marks the
restart) — the health endpoint is CDN-cached and will lie to you.

---

## 8. STATE AT HANDOFF (2026-08-27, verified not remembered)

|                                |                                            |
| ------------------------------ | ------------------------------------------ |
| CA `main`                      | `3924dc8708`                               |
| WH `main`                      | `27f3e0a6e2`                               |
| Production                     | serving, healthy; deploys flowing normally |
| `ad_event` rows                | **76** — tracking is live and recording    |
| `fn_unaccounted_seat_exits()`  | **0**                                      |
| `economy_invariants()` failing | **0**                                      |

Merged this session: CA #1478 (ad system + admin panel), CA #1487 (cash-out/add-on
race), WH #824 (ad write path + ad-free claim removal), WH #864 (dead-wiring
sweep). WH #860 closed as a duplicate of #857.

**Two items left for Dan, not for you** — both need a decision, not code:

- `Smarter-Poker-World-Hub/src/components/ClubArena/Lobby.tsx` contains a
  "MANDATORY DISCLAIMER" gate and a **"PLAY MONEY ONLY — NO CASH VALUE"** badge
  and has **zero importers**. That text exists nowhere else in the repo, so
  whatever compliance need it was written for, **no live surface currently meets
  it.** Wiring a legal gate is a legal decision.
- `club-arena/src/pages/ClubDetailPage.tsx` is 2,025 lines (club settings, table
  delete, member approval) imported by nothing; the router points
  `clubs/:clubId` at `ClubHomePage`. Anyone "fixing club settings" there would
  ship nothing.
