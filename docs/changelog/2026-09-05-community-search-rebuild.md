# 2026-09-05 - Community search is one ranked, union-aware index

**Trigger.** Dan, on `/search?q=MIDWAY` (2026-09-04): "THIS ENTIRE PAGE NEEDS
AN AUDIT AND FULL ENHANCEMENT AND UI UPGRADE ... THE FUZZY MATCH DOESN'T MATCH
RIGHT, ITS DISPLAYING MIDWAY UNION WITH ONLY 328 MEMBERS, INSTEAD OF THE REAL
TOTAL, ITS NOT PULLING REAL CLUB IMAGES OR ANYTHING. BUTTONS ARE COVERED, AND
THE BUTTONS ON THE PAGE DON'T WORK.... LIVE INDESES DEAD, CURRET SCOPE DEAD".

## What was actually wrong (all read, none assumed)

| Symptom                                                                                                               | Cause                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Result list rendered under the footer, outside the panel; "Clear" clipped to `CLEA` under Search; buttons unclickable | `SearchPage.css` used global class names. `components/common/Search.css` (loaded by the header on every page) defines `.search-results { position: absolute; top: 100% }` and `.search-clear { width: 20px }`.         |
| Midway Union "328 Members"                                                                                            | The page read `clubs.member_count` of the union's HOUSE row. A union's total is every club's members summed (Dan 2026-08-24; the union lobby already does this): `fn_batch_union_realtime_member_counts` -> **1,177**. |
| No club image                                                                                                         | Read `clubs.avatar_url` (null). The logo is `clubs.logo_url` = `/hub/club-arena/images/midway-union-logo.jpg`.                                                                                                         |
| "Fuzzy" match                                                                                                         | Plain `ilike '%q%'`, no ranking, no typo tolerance, no multi-word, no slug / club-number match. Players were a raw `ilike` on `profiles` that bypassed `fn_search_players` and the discoverable preference.            |
| Live Indexes / Current Scope dead                                                                                     | `value: 4` literal; scope was a lowercase static string.                                                                                                                                                               |

## What shipped

**Migration `20260905040000_community_search_is_one_ranked_union_aware_index.sql`**
(applied to production 2026-09-05 00:0x UTC, one transaction, one reload):

- `fn_community_search(p_query, p_scope, p_limit) -> jsonb` - SECURITY
  DEFINER, authenticated only. Clubs (union-aware live member count, live
  open-table / seated / tournament counts, resolved image, viewer membership),
  open tables (visibility re-applies `tables_select_scoped`), live tournaments
  (re-applies `tournaments_select_scoped`, `is_registered`), `totals` per
  index, and `index_health` (live record counts) on every call.
- `fn_community_search_score(haystack, tokens, fuzzy) -> real` - the one
  matching rule: every token must land; exact 1.0 > prefix/word 0.95 >
  substring 0.85 > trigram `word_similarity >= 0.5` (tokens of 3+ chars, query
  of 3+ chars). Score = mean across tokens. Club-name-only matches for tables /
  tournaments are scored at 0.7x so a table named for the query outranks a
  table merely hosted by a club named for it.

Probed first as `pg_temp` copies in a rolled-back transaction with
`request.jwt.claims` set to Dan's uid. Measured:

| Query                 | Result                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MIDWAY`              | Midway Union first (0.95), `is_union` true, **1,177** members, 84 tables, 84 seated, 195 tournaments, image resolved; totals clubs 1 / tables 84 / tournaments 195 |
| `midwya` (typo)       | Midway Union                                                                                                                                                       |
| `55555` (club number) | Midway Union                                                                                                                                                       |
| `jaqk`                | Club JAQK, 584                                                                                                                                                     |
| `plo6 turbo`          | DSS Saturday $8.80 PLO6 Turbo first; 23 tournaments                                                                                                                |
| `nlh 0.25`            | NLH 0.25/0.50 (8/9 seated) first; 11 tables                                                                                                                        |
| `freerol` (typo)      | $100 Freeroll; 102                                                                                                                                                 |
| `zzzzqq` / blank      | 0 / 0                                                                                                                                                              |

Full scan + scoring of all 187 open tables and 369 live tournaments: 41 ms.

**`src/pages/SearchPage.tsx` + `SearchPage.module.css`** (old `SearchPage.css`
deleted):

- CSS module; no class shared with the header stylesheet. Buttons are
  reachable again.
- One RPC call for clubs / tables / tournaments + `fn_search_players` for
  players, in parallel, `allSettled`; per-index status drives the header.
- Header metrics are measured: **Live Indexes** = indexes that answered this
  query over indexes consulted (attention tone when one failed); **Current
  Scope** = the live tab; **Results** = total matches across indexes (not the
  rows shown).
- Live index strip under the search field: each index with its live record
  count and a green / red dot; tapping one scopes the search.
- Category rail carries per-tab match counts once a query has run.
- Result cards per type: club / union (logo, UNION or CLUB pill, level,
  members / tables / seated / tournaments, membership pill, Open Lobby,
  Union Hub), player (avatar, presence dot, relationship pill, Add Friend /
  Message), table (variant tile, stakes, seat meter, Running / Waiting,
  Observe revalidated through `fn_get_table_watch_access` at click time,
  Club), tournament (status pill, buy-in, GTD / pool, players, start time
  relative, Bounty / Turbo, Registered, Register / Watch / Open Lobby, Club).
- "View All N" per group in network scope switches to that index.
- Mobile-first at 375px; desktop adds the fourth column and inline actions.

**Tests**

- `tests/community-search-owns-its-classes.law.test.ts` (+ `docs/laws.d/`
  entry): module CSS, no class overlap with `common/Search.css`, no direct
  table reads, players via the RPC, Live Indexes measured, migration shape.
- `tests/unit/searchPageHelpers.test.ts`: the pure helpers.
- `tests/unit/communityCommandCenter.test.ts` updated in the same commit for
  the pins it deliberately replaced.

## Not changed

- `clubs.member_count` / `trg_sync_club_member_count` - the column is still
  wrong for union house rows by design (it counts the house roster). The
  search page no longer reads it; the lobby never did.
- `fn_search_players` - untouched; the page consumes it as-is.
