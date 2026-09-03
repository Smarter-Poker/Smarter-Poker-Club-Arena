# House Ads Phase 3 — handoff

Written 2026-08-28 by the agent that did Phase 2. Read the Phase 2 brief at
`.agent/handoffs/2026-08-27-house-ads-phase-2.md` for the system's shape and its
reason for existing; this file is only the delta, and it is as honest as that one
was.

---

## 1. Read this before you plan anything

**Two of the three things Phase 2 opened with were not bugs.** I proved both and
changed no code for either. Do not re-open them:

- **0 dismisses is correct.** `AdService.logDismiss` has zero callers and no
  dismiss control is rendered anywhere. The event type is unreachable by design.
  Building one is a **product call for Dan** — he ruled everyone sees ads.
- **0 clicks has no defect.** The CHECK allows `click`; RLS accepts the insert
  (proved in a rolled-back transaction as the real user who owns 92 impressions);
  the click is logged before a **react-router** navigate, so no unload kills it;
  all four target routes exist. Nobody tapped it. That is a plausible zero.
- **`vip_upsell` at weight 120 with 0 impressions is correct.** All four users
  who have ever seen an ad are `is_vip = true`; the campaign targets `non_vip`.
  269 non-VIP profiles exist, so it is not structurally dead.

The lesson worth keeping: on this system the event log's _absence_ is usually
telling the truth. Prove the write path with a rolled-back probe before you
"repair" anything.

## 2. What Phase 2 shipped

World Hub PR **#903** (`feat/hub-promotions-surface`) — the `hub_promotions`
slot now has a render surface. Three files, all in the World Hub repo:
`src/services/adService.js`, `src/components/ads/HubPromoRail.jsx`, and a mount
in `pages/hub/promotions.js` above the venue feed.

The DB side needed nothing: all six campaigns already carried a
`hub_promotions` placement with a correct Hub-relative `target_url`.

Changelog: `docs/changelog/2026-08-27-house-ads-phase-2.md` (this repo).

## 3. First thing you should do

**Confirm PR #903 published, and that the slot actually records events.** Do not
take my word for it. Two checks, in order:

```bash
curl -s https://smarter.poker/api/health          # the SHA production serves
```

then, in Supabase:

```sql
select slot, event_type, count(*), max(created_at)
from ad_event group by 1,2 order by 1,2;
```

A row with `slot = 'hub_promotions'` is the proof. As of this handoff there was
**none** — every one of the 131 rows was `lobby_strip`. If none has appeared
after the deploy and someone has visited `/hub/promotions` while signed in,
something in that rail is not reaching the table, and _that_ is a real bug worth
your time.

I could not run `npx next build` locally: the sandbox volume was at 100% with no
room for `npm install`, and the mounted host `node_modules` is macOS binaries.
CI's build was the first real gate. Check it landed green.

## 4. Then, in priority order

**P2 — `session_summary` and `empty_state`.** Same service, new mount points.
`empty_state` pairs with Club Arena's existing lobby empty view: genuinely dead
space, honest to fill. Done means real rows in `ad_event` carrying those slot
values, from a real render — not from a seeded placement.

**P3 — reporting.** `HouseAdsPage` shows impressions/clicks/dismisses per ad and
nothing else. It cannot show CTR over time, per-club breakdown, or which slot
performed better. All the data is in `ad_event` and both indexes exist. Read
only, low risk, high operator value, and it is the first thing that will make
the Hub surface worth having shipped. **`stats === null` means "could not
count", not zero — render `-`.** A fabricated zero on a metrics surface is a lie
an operator will act on.

**P4 — `table_between_hands`. Highest risk; read the Phase 2 brief's section 5
before touching it.** An ad rendered near a live decision or live money is a
fairness question, not a design one. Nothing may overlap action controls, steal
a tap, or animate during a hand.

## 5. Two open questions that need Dan, not an agent

1. **`spins_jackpot` and `bbj_running` point at `/`.** Not laziness in the seed
   data — **there is no route to point them at.** Spins has no route in
   `App.tsx` at all; BBJ is club-scoped at `clubs/:clubId/jackpot` and the
   resolver does not template a club id into a `target_url`. Options: add a
   global route for each, teach the resolver to substitute `p_club_id`, or leave
   them on the lobby. All three are product decisions.
2. **Should a dismiss control exist?** See section 1.

## 6. Traps I hit, so you do not

- **Every local clone on Dan's Mac was stale** and contained none of the house
  ads code — `club-arena`, `Smarter-Poker-Club-Arena` and
  `Smarter-Poker-World-Hub` all of them. They will tell you `AdService.ts` and
  `house-ads.js` do not exist. They do. **Trust `main`, not the checkout.**
- **The GitHub MCP answers `Bad credentials`.** Its static token is dead again
  (this is the 2026-08-22 failure recurring — see AGENT-PLAYBOOK section 8). Not
  a blocker: `gh` works on the host, and from a sandbox the fine-grained PAT in
  the World Hub's `.env` reaches the API fine.
- **The Club Arena repo is `Smarter-Poker/Smarter-Poker-Club-Arena`.** The
  lowercase `Smarter-Poker/club-arena` 404s — the rename happened. The local
  folder is still named `club-arena`.
- **The sandbox `/sessions` volume was 100% full.** `/tmp` had room. If `npm`
  says `nospc`, that is what happened.
