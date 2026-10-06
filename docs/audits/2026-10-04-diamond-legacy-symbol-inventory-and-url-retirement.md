# The Diamond Arena legacy symbol inventory and the old-URL retirement check

Written 2026-10-04. Read-only audit for Phase 12 of
[the Diamond Arena programme](../POKER-ARENA-DIAMOND-BUILD-PROGRAMME.md), line 8:
"Search both repositories and deployment configuration for every inventoried
legacy symbol/path; document each remaining match as shared infrastructure or
historical evidence. Verify old URLs expose no Diamond Arena screen, API or
redirect alias."

Nothing was deleted, changed, published or deployed to produce this file. Every
database reading came from `SELECT` inside a read-only repeatable-read
transaction against project `kuklfnapbkmacvwxktbh`. Every URL reading came from
`curl` and is quoted with the status code it returned. Both arena switches were
`false` throughout (`ca_arena_settings`: `cash_games_enabled` false,
`tournaments_enabled` false, read 2026-10-04 21:48 UTC), so the release has not
happened and none of the deletions this file scopes are due yet.

## 1. Where the inventory came from

The programme's Legacy Removal Contract says the inventory is built in Phase 2.
It exists, at
[`audits/2026-09-08-diamond-phase-2-access-and-legacy-inventory.md`](2026-09-08-diamond-phase-2-access-and-legacy-inventory.md),
and it names two sets: six **live database retirement targets** and
**thirty-one World Hub source paths** matched at baseline
`7c4035bcea827b89f924a8616fd99abdc813f887`. This audit works from that list and
does not invent a replacement for it.

It does extend it, with evidence, in two places the Phase 2 pass did not reach:

1. The Phase 2 World Hub list is **incomplete**. Eighteen further World Hub
   runtime files match `diamond.?arena` on today's `origin/main` and are not on
   that list (section 4.2). Most are current copy, but four are player-facing
   or legal claims that no longer match the product (section 6).
2. The Phase 2 list contains no entry for the **standalone legacy application**:
   its own repository (`Smarter-Poker/Smarter-Poker-Diamond-Arena`), its own
   Vercel project, its own hostname `diamond.smarter.poker`, and its own
   database tables (section 5). Phase 12's deletion lines cover "deployment
   targets" and "obsolete configuration", so those belong here.

Trees read: Club Arena `origin/main` at `188d96f259`, World Hub `origin/main` at
`f23bcfa10c9`. Both were fetched for this audit. The canonical World Hub clone
at `~/Documents/Smarter-Poker-World-Hub` is 19 behind and **1 ahead** of
`origin/main`, which is the jam CLAUDE.md 10.87 rule 3 describes; this audit read
`origin/main` through `git show`/`git grep` rather than the working tree, so the
finding does not affect it, but somebody should look at that commit.

## 2. How a match was classified

Four classes, decided from what the code or the database actually does, never
from the name:

- **Live** the current Poker Arena or the shared estate depends on it today.
- **Shared** infrastructure the arena uses and the rest of the estate also uses;
  it survives the deletion.
- **Evidence** a migration file, a journal class, a changelog or an audit that is
  the record of what happened. The programme preserves these by name.
- **Deletable** no live caller, no live reader, no evidence value; safe once the
  release lands and the stated precondition is met.

"Disabled or unreachable code does not satisfy removal" (Phase 12). So a function
that exists with zero callers is **Deletable**, not already removed, and this
file says what has to move with it.

## 3. The six live database retirement targets

All four functions still exist in production, verified from `pg_proc` with
`prokind='f'`.

| Symbol | Production state | What actually references it | Class |
| --- | --- | --- | --- |
| `fn_arena_deposit(integer,text)` | exists, SECURITY INVOKER, 0 `pg_depend` referrers | `fn_guard_profile_privileged_columns()` names it in its money-door allowlist. Zero callers in `src/` or `server/`. | **Deletable** |
| `fn_arena_withdraw(integer,text)` | exists, SECURITY INVOKER, 0 `pg_depend` referrers | same guard, same allowlist. Zero callers in `src/` or `server/`. | **Deletable** |
| `fn_ca_arena_diamonds()` | exists, SECURITY DEFINER, STABLE | **called** by `fn_ca_diamond_trial_balance` and `fn_ca_diamond_snapshot`; **existence-tested** by `fn_ca_diamond_offledger_float`; named in `fn_ca_circulation_total` and `fn_snapshot_chip_supply` as the reason each one excludes Diamond custody | **Live** |
| `fn_ca_arena_seat_is_same_asset()` | exists, SECURITY DEFINER, 1 `pg_depend` referrer | trigger `trg_ca_arena_seat_is_same_asset`, `AFTER INSERT ON public.table_seats FOR EACH ROW`, enabled (`tgenabled='O'`); **sole consumer** of rule `DR15:cross_asset_seat` | **Live** |
| `ca_arena_settings` | 1 row | read by eleven live functions and by `server/src/services/supabase/tables.ts:38,88`; holds both release switches | **Shared** |
| `club_members` historical Diamond row | preserved | the membership record from before automatic entitlement | **Evidence** |

### 3.1 Two of these are not safe to drop, and the names are why they look safe

`fn_ca_arena_diamonds()` reads, verbatim from `pg_get_functiondef`:

```sql
SELECT (SELECT COALESCE(sum(balance),0)::numeric FROM public.poker_diamond_custody)
  +(SELECT COALESCE(sum(pending_diamonds),0)::numeric FROM public.diamond_spin_days WHERE status='open');
```

That is the arena float, and it is an argument to the trial balance. The Phase 2
inventory calls it a "legacy balance reader" to be retired "after updating its
callers and accounting reports". Its callers today are the accounting reports.
Worse, `fn_ca_diamond_offledger_float` opens with

```sql
IF to_regprocedure('public.fn_ca_arena_diamonds()') IS NULL THEN
  RETURN 0;
END IF;
```

so dropping the function does not raise. The off-ledger float silently becomes
zero while `fn_ca_circulation_total` and `fn_snapshot_chip_supply` keep excluding
Diamond custody on the stated grounds that this function counts it. The arena
float would leave the books in both directions at once, and the trial balance
would keep reading clean. **Do not drop `fn_ca_arena_diamonds()` in Phase 12.**
If the name is the objection, rename it in a forward migration that moves every
caller in the same transaction.

`fn_ca_arena_seat_is_same_asset()` is the only function in the database whose
body contains the string `DR15:cross_asset_seat` (verified by scanning every
`prokind='f'` body). `DR15` is in `refuse` mode, flipped `2026-09-22 06:50 UTC`
by `auto:flip_due`. Drop the function and `DR15` becomes a rule with no consumer,
which is the exact state migration `20260919223115` had to repair for `DR16`:
the daily arming sweep refuses with "no function consults this rule". The trigger
is also `AFTER INSERT FOR EACH ROW` on `table_seats`, a hot table, so its removal
is DDL under CLAUDE.md section 2 rules 1 and 7, not a one-liner.

### 3.2 What has to move with the two deletable doors

`fn_arena_deposit` and `fn_arena_withdraw` have no runtime caller, but
`fn_guard_profile_privileged_columns()` still names both in its allowlist of
functions permitted to write `profiles.diamonds`. Migration `20260930121500`
records why that matters, verbatim from its header: "none of the three is listed
(the list still names `fn_arena_deposit`, the door the custody reserve
replaced)". So the forward migration that drops the two doors must also remove
their two allowlist entries, or the guard is left naming functions that do not
exist. That is cosmetic rather than dangerous, but it is the kind of dangling
name that the next audit spends an hour on.

`20260914024241` also edits an existing function in place whose body carries the
regex `'function (public[.])?fn_arena_withdraw[(]'` as a call-stack pattern.
Dropping the function leaves that pattern matching nothing. Harmless, and worth
removing in the same migration so the two facts stay together.

### 3.3 The journal classes are not legacy and never become legacy

`arena_deposit` and `arena_withdraw` are also `diamond_transactions.type` values,
and they are what **today's** doors write. From
`fn_poker_diamond_reserve`'s body, verbatim:

```sql
INSERT INTO public.diamond_transactions(user_id,type,transaction_type,...)
VALUES(p_user_id,'arena_deposit','arena_deposit',-p_amount::integer,...)
```

Seven live functions write or classify `arena_withdraw`:
`fn_poker_diamond_release`, `fn_poker_diamond_tournament_pay`,
`fn_poker_diamond_tournament_cancellation_receipt`, `add_diamonds_to_balance`,
`fn_ca_diamond_journal_origin`, `fn_diamond_kind_bucket`,
`fn_diamond_kind_row_label`. The World Hub's
`src/components/store/DiamondWalletModal.jsx` labels both types for the player.
**Class: Shared, permanently.** A deletion pass that greps for `arena_deposit`
would take out the label on every live Diamond buy-in receipt.

## 4. The World Hub source inventory

### 4.1 The thirty-one inventoried paths

Nine were deleted in Phase 5 and are gone from `origin/main`: the six
`pages/hub/diamond-arena*` page files, `src/services/diamondArenaPreferences.js`,
`src/stores/diamondArenaStore.js`, `src/styles/worlds/diamond-arena.css`.

Twenty-two survive, because they are shared files that merely matched the
pattern. Fifteen of them now contain **no** `diamond.?arena` match at all,
verified file by file against `origin/main`: `pages/_app.js`,
`pages/hub/[orbId].js`, `pages/sitemap.xml.js`,
`src/components/WorldThemeProvider.js`, `src/config/bottom-nav-routes.json`,
`src/config/world-footer-navigation.json`, `src/config/worldMenuNavigation.js`,
`src/lib/liveHelp/contextCollector.ts`, `src/lib/storage.js`,
`src/registry/masterIndex.ts`, `src/scripts/addPageTransitions.js`,
`src/scripts/batchPageTransitions.js`, `src/types/world.d.ts`,
`src/world/PremiumHub.tsx`, `src/world/components/CardCustomizerPanel.tsx`.
Nothing is owed on those.

Seven still match, and each one is Live or Evidence. The approved artwork is
listed with them because the inventory names it in prose as a preservation item
rather than in the path list:

| Path | The remaining match | Class |
| --- | --- | --- |
| `src/state/worldStore.ts:81` | the zustand persist `migrate` that turns a cached `activeOrb === 'diamond-arena'` into `null` | **Live**, see 4.3 |
| `src/lib/liveHelp/knowledgeInjection.ts` | the `diamond_arena` knowledge category, re-keyed on the arena itself by the 2026-09-20 fix | **Live** |
| `src/lib/liveHelp/jarvisKnowledgeBase.md` | section 6, "Diamond Arena is a selection inside Poker Arena at `/hub/club-arena`" | **Live**, correct |
| `src/lib/liveHelp/agentPrompts.ts:49` | the same statement in the agent prompt | **Live**, correct |
| `src/orbs/manifest/registry.ts:24` | the Poker Arena orb description, "SHARK CLUB, DIAMOND ARENA AND YOUR JOINED CLUBS" | **Live**, correct |
| `pages/investor.js:40` | the pitch slide `/images/pitch/v4_slide_10_diamond_arena_1772657329877.webp` | **Evidence** |
| `src/config/hamburgerMenus.js:1175` | a comment recording what the old configs did | **Evidence** |
| `public/cards/diamond-arena.png` (named in prose) | the approved original artwork | **Evidence**, pinned by `__tests__/poker-arena-entry.test.mjs:16` |

### 4.2 Eighteen further runtime matches the Phase 2 pass missed

Twenty-five World Hub runtime files match `diamond.?arena` on `origin/main`;
seven are the inventoried ones above. The other eighteen:

- **Live and correct copy** describing the arena as it is now:
  `public/llms.txt`, `pages/api/store/diamond-transactions.js` (its header rule
  "THE DIAMOND ARENA IS DIAMONDS ONLY: nothing in this read is a chip"),
  `src/content/glossary/terms.js`, `src/components/diamonds/DiamondRewardTracker.tsx`,
  `src/config/diamondRewards.js`, `src/components/profile-edit/CardDeckPreferenceSection.js`,
  `pages/hub/diamond-store.js`, `src/data/diamondStoreData.js` (the store category
  label "Club & Diamond Arena", fifteen occurrences),
  `src/lib/geevesKB/trainingAndDiamonds.js`, `src/lib/geevesKB/worldHub.js`.
- **Shared, permanently**: `src/components/store/DiamondWalletModal.jsx`, for the
  reason in 3.3.
- **Stale copy, no route exposure**: `src/world/components/GlobalSearch.tsx:124`
  and `src/world/components/Geeves/AutoComplete.tsx` carry the string "Diamond
  Arena" as a suggestion. `GlobalSearch`'s is inside a `mockResults` array with
  no destination, so it is not a dead link; it is a stale suggestion.
  `src/world/WorldHub.tsx` has a stale comment about tile order.
- **Player-facing or legal claims that no longer match the product**, four files,
  in section 6: `pages/hub/help.js`, `pages/legal/official-rules.js`,
  `pages/terms.js`, `pages/auth/signup.js`.

### 4.3 The one World Hub match that looks legacy and is load-bearing

`src/state/worldStore.ts` persists under key `world-store-v1` and carries:

```ts
version: 1,
// Retire a cached standalone selection without changing other saved worlds.
migrate: (persisted) => {
  const saved = persisted as { activeOrb?: string | null };
  return { activeOrb: saved?.activeOrb === 'diamond-arena' ? null : saved?.activeOrb ?? null };
},
```

`version: 1` and `migrate` were added **together** in `606a789e169`
(2026-09-09, PR #1701, the Phase 5 entrance change). Before that commit the
persisted state carried no version, so for any browser whose `world-store-v1`
was last written before 2026-09-09 this migration runs once and clears the dead
selection. Delete it and that cohort gets `activeOrb: 'diamond-arena'` restored,
pointing at a route that answers 404 (section 7).

**No test pins it.** `git grep` across `__tests__` and `e2e` found nothing
asserting the purge. That is a guard with no reader (CLAUDE.md 10.83) and it is
the one piece of this inventory that would be removed by a correct-looking
cleanup. It should keep a regression test before anyone touches that file, and it
should stay until Dan is willing to say that the pre-September-9 cohort no longer
matters.

## 5. The standalone legacy application, its host and its tables

Not in the Phase 2 inventory. All of it read-only.

| Resource | What was read | Class |
| --- | --- | --- |
| `Smarter-Poker/Smarter-Poker-Diamond-Arena` | local clone at `~/Documents/diamond-arena`, last commit `b25b60c` 2026-08-19; carries `src/orbs/DiamondArena/*`, `src/engines/economy/*` and `api/cron/*`, and `supabase/.temp/project-ref` names the **production** project | **Deletable** target, already defanged |
| its Vercel project | `.vercel/project.json` names `prj_5b1rWISALE9TULCm3sQKvY1M5FSa`; `get_project` returns `404 Project not found` | already gone |
| `diamond.smarter.poker` | `dig`: A records `216.150.1.193`, `216.150.1.65` (Vercel). `curl`: `http=404`, body `The deployment could not be found on Vercel.DEPLOYMENT_NOT_FOUND` | **Deletable**, and see 5.1 |
| `next.config.js:738` in World Hub | `{ protocol: 'https', hostname: 'diamond.smarter.poker' }` still in `images.remotePatterns` | **Deletable** |
| `public.diamond_arena_events` | 0 rows, RLS on, one SELECT policy, **not** in any publication, no inbound foreign key, no function, view or cron reference, no code reference in either repo | **Deletable** |
| `public.diamond_arena_scores` | already dropped, by `20260314_drop_orphan_tables.sql` | gone |
| `profiles.diamond_arena_preferences` | 3 non-null rows; read by `fn_close_account(uuid)` and `update_page_preferences(uuid,text,jsonb)`; pinned column-by-column by `scripts/ci/probes/owner-operational-notification/provider-check.sql` | **Shared** |

The repository is not a live publisher. `.github/scripts/estate-integrity.sh`
records, verbatim, that `Smarter-Poker-Diamond-Arena` is "a parked repository
with no active publisher", that its own PR #64 (`d70fcbcd1928`, 2026-09-18)
deleted `agent-autopilot.yml` and `agent-open-pr.yml`, and that it added
`tests/deployment-controls.test.mjs` there to reject both files returning. Club
Arena has no authority over that repo (CLAUDE.md 1.2), so its retirement is a
separate owner action, not a Club Arena merge.

### 5.1 The dangling hostname is the one item here with a risk attached

`diamond.smarter.poker` still resolves to Vercel's anycast addresses while no
Vercel project claims it. On a shared platform that is a subdomain anyone with an
account on the same platform may be able to claim. Nothing in either repository
depends on it any more except the `images.remotePatterns` entry. **Removing the
DNS record is Dan's action**; it is not a repository change and no agent should
attempt it.

## 6. Four live surfaces describe a Diamond Arena that does not exist

These are the only findings in this audit where something the programme treats as
retired is still being shown to a player. None is a route or an API; all four are
copy, and three of the four make economic claims, which CLAUDE.md 10.9 reserves
to Dan.

| File | What it says now | Why it is wrong |
| --- | --- | --- |
| `pages/legal/official-rules.js` | "Smarter.Poker Diamond Arena Sweepstakes & Promotional Rewards Program", and "Free Roll Hourly Tournaments: Enter The Diamond Arena Every Hour With ZERO Entry Fee" | a published legal page promising hourly free entries. `tournaments_enabled` is false and the guarantee and promotional-entry decisions are the Phase 9 lines still waiting on Dan |
| `pages/terms.js` | "Diamond Arena: Competitive Training Challenges" and "Diamond Arena: Prize Redemptions Enabled" | describes the retired arcade, and asserts redemptions are on |
| `pages/hub/help.js` | "The Diamond Arena is our competitive poker room where you can play cash games and tournaments" | both switches are off |
| `pages/auth/signup.js` | "Your Universal ID Across PokerIQ, Diamond Arena & Club Arena", and a restricted-states block on "Diamond Arena Prize Redemptions" | treats the arena as a sibling of Club Arena rather than a selection inside it |

This audit changes none of them. The wording of a legal page and the existence of
a free entry are both Dan's.

## 7. The old URLs expose no Diamond Arena screen, API or redirect alias

Read 2026-10-04 with `curl -L`, status and body quoted as returned.

| URL | Result |
| --- | --- |
| `https://smarter.poker/hub/diamond-arena` | `http=404 redirects=0 ctype=text/html bytes=5700` |
| `https://smarter.poker/hub/diamond-arena/history` | `http=404 redirects=0 bytes=13298` |
| `https://smarter.poker/hub/diamond-arena/leaderboard` | `http=404 redirects=0 bytes=13298` |
| `https://smarter.poker/hub/diamond-arena/schedule` | `http=404 redirects=0 bytes=13298` |
| `https://smarter.poker/hub/diamond-arena/stats` | `http=404 redirects=0 bytes=13298` |
| `https://smarter.poker/hub/diamond-arena/table-settings` | `http=404 redirects=0 bytes=13298` |
| `https://smarter.poker/diamond-arena` | `http=404 redirects=0 bytes=13298` |
| `https://smarter.poker/arena` | `http=404 redirects=0 bytes=13298` |
| `https://diamond.smarter.poker/` | `http=404 redirects=0 ctype=text/plain bytes=107`, body `The deployment could not be found on Vercel.DEPLOYMENT_NOT_FOUND cle1::fqrln-1791149045591-be92678f0b4e` |
| `https://smarter.poker/api/diamond-arena` | `http=404 redirects=0` |
| `https://smarter.poker/api/diamond-arena/events` | `http=404 redirects=0` |
| `https://smarter.poker/api/hub/diamond-arena` | `http=404 redirects=0` |
| `https://smarter.poker/api/arena/orbs` | `http=404 redirects=0` |

Three things were checked beyond the status code, because a 404 page has a body
too and 92 route specs in this estate once sat green on one:

1. **No redirect, anywhere.** `num_redirects` is `0` on every row, and
   `url_effective` equals the requested URL on every row. Nothing forwards to the
   new arena and nothing forwards away from it.
2. **No Diamond Arena content in the 404 body.** `/hub/diamond-arena` returns the
   App Router `_not-found` page, 5700 bytes against the Pages Router's 13298, and
   the **only** occurrence of `diamond-arena` in it is the router echoing the
   requested segments inside the not-found payload:
   `0:{"P":null,"c":["","hub","diamond-arena"],...["_not-found",...`. No iframe
   element, no reference to `diamond.smarter.poker`, title `Smarter.Poker`.
3. **No redirect alias in deployment configuration.** World Hub `vercel.json`'s
   `redirects` array holds two entries, both for `/Portfolio`; its `rewrites`
   array holds six, for `commander.smarter.poker` and the portfolio. Neither
   mentions diamond. `next.config.js`'s `redirects()` was read end to end: the
   Vercel-alias canonicalisation, the auth short forms, `/legal/*`,
   `/hub/live-help`, the Club Arena share-link set, the avatar page names,
   memory-games to preflop-charts and marketplace to diamond-store. **No
   `/hub/diamond-arena` entry of any kind.** `middleware.ts` matches on
   `/api`, the www canonicalisation and the jurisdiction gate, and names no
   diamond route.

The only reference to the retired host left in live configuration is the
`images.remotePatterns` entry at `next.config.js:738`, which is a permission to
load an image from a host that no longer serves one. It is not a route and not an
alias.

## 8. What a grep-and-delete pass would destroy

Three traps, each verified against production:

1. **`diamond-arena` is the live arena's own slug.** `public.clubs` holds exactly
   one platform row: name `Diamond Arena`, slug `diamond-arena`, asset
   `diamonds`, `is_platform` true, id `002c2d27-9584-4e52-835a-bb2be148fc81`.
   Every Club Arena route the arena is reached by is
   `/hub/club-arena/clubs/diamond-arena`, and `src/lib/constants.ts:235` exports
   `DIAMOND_ARENA_SLUG = 'diamond-arena'`. All 40-odd Club Arena `src/` matches
   for `diamond-arena` and `diamondArena` are the **new** arena.
2. **`arena_matches`, `arena_orbs` and `arena_sessions` are a different Arena.**
   `arena_sessions` columns are `questions_attempted, correct_answers, score,
   time_remaining`; `arena_orbs` is `orb_name, color_code`. That is the World Hub
   trivia and orb feature, not the poker arena. `arena_sessions` is also still
   read by `fn_check_level_advancement(uuid)` and written by
   `record_arena_session(...)`. Out of scope for Diamond Arena retirement, and
   not safe to drop on the strength of the prefix.
3. **`arena_deposit` and `arena_withdraw` are live journal classes**, section 3.3.

## 9. The deletion order this implies

Not a licence to start. Every item below waits on the release, and the two
database steps additionally wait on CLAUDE.md section 2 (one migration, one
transaction, outside the :50 to :03 break window, with `lock_timeout` set).

1. `public.diamond_arena_events` drops cleanly in one forward migration. Nothing
   reads it, nothing references it, it holds no rows.
2. `fn_arena_deposit(integer,text)` and `fn_arena_withdraw(integer,text)` drop in
   one forward migration **that also** removes their two entries from
   `fn_guard_profile_privileged_columns()`'s allowlist and the dead
   `fn_arena_withdraw[(]` stack pattern. REVOKE first and leave it for 24 hours,
   per the roadmap's own gate for this class of deletion.
3. The `images.remotePatterns` entry for `diamond.smarter.poker` is a one-line
   World Hub change through its normal route.
4. `fn_ca_arena_diamonds()` and `fn_ca_arena_seat_is_same_asset()` are **not**
   Phase 12 deletions. If they are to be renamed, each needs a forward migration
   that moves every caller, or every rule consumer, in the same transaction.
5. `profiles.diamond_arena_preferences`, `ca_arena_settings`, the `club_members`
   historical row, the migration files, the journal classes and
   `public/cards/diamond-arena.png` all survive the deletion, by the programme's
   own preservation rule and by the evidence above.
6. The `diamond.smarter.poker` DNS record and the parked repository are Dan's
   actions, not a Club Arena merge.

## 10. Counts

| | Count |
| --- | --- |
| Inventoried World Hub paths | 31 |
| of those, deleted in Phase 5 | 9 |
| of those, surviving with zero remaining match | 15 |
| of those, surviving with a remaining match | 7 |
| Further World Hub runtime files matching, not inventoried | 18 |
| World Hub files matching `diamond.?arena` in total, on `origin/main` | 84 |
| Club Arena files matching one of the five database symbols | 228 |
| of those, runtime source | 1 (`server/src/services/supabase/tables.ts`) |
| of those, runtime tests | 3 |
| of those, migrations (Evidence, preserved) | 73 |
| of those, documents and changelogs (Evidence) | 61 |
| of those, tests and law tests (Shared) | 51 |
| of those, CI fixtures and pinned schema snapshots (Shared) | 39 |
Classification of every remaining match, counted once each:

| Class | Named symbols and files | Plus, by class |
| --- | --- | --- |
| **Live** | 17: `fn_ca_arena_diamonds`, `fn_ca_arena_seat_is_same_asset`, `server/src/services/supabase/tables.ts`, `worldStore.ts`, `knowledgeInjection.ts`, `jarvisKnowledgeBase.md`, `agentPrompts.ts`, `orbs/manifest/registry.ts`, and the ten World Hub files carrying current arena copy | |
| **Shared** | 4: `ca_arena_settings`, `profiles.diamond_arena_preferences`, the `arena_deposit`/`arena_withdraw` journal classes, `DiamondWalletModal.jsx` | 51 Club Arena test files, 39 Club Arena CI fixtures, 7 World Hub tests, 9 World Hub fixtures |
| **Evidence** | 4: the `club_members` historical row, `public/cards/diamond-arena.png`, `pages/investor.js`, the `hamburgerMenus.js` comment | 73 Club Arena migrations, 61 Club Arena documents, 16 World Hub migrations, 21 World Hub documents and audits |
| **Deletable** | 4: `public.diamond_arena_events`, `fn_arena_deposit`, `fn_arena_withdraw`, the `next.config.js:738` `remotePatterns` entry | plus three owner-side resources: the DNS record, the parked repository, the already-deleted Vercel project |
| **Stale copy, needs a decision** | 7: `GlobalSearch.tsx`, `AutoComplete.tsx`, `WorldHub.tsx` (cosmetic), and the four section 6 surfaces (Dan's) | |
| **Out of scope, name-only** | `arena_matches`, `arena_orbs`, `arena_sessions`, and the live `diamond-arena` club slug with every Club Arena `src/` file that uses it | |

## 11. Is the programme line satisfiable now

**The search half is satisfied by this document.** Every inventoried symbol and
path has been searched for in both repositories and in both deployment
configurations, and every remaining match is classified from evidence.

**The URL half is satisfied for today's reading**, section 7, with the one caveat
that a 404 proven today is a claim about a world that changes
(CLAUDE.md 10.86); re-read it at the release.

**The line as a whole is not tickable yet**, because it sits inside a phase whose
deletions have not happened and must not happen before the release. What this
document removes is the risk that those deletions start cold.

## 12. What needs Dan

1. The four live surfaces in section 6, in particular the hourly free entries
   promised on `pages/legal/official-rules.js` and the "Prize Redemptions
   Enabled" line on `pages/terms.js`. Both are economics.
2. The `diamond.smarter.poker` DNS record, section 5.1.
3. Retiring `Smarter-Poker/Smarter-Poker-Diamond-Arena`, or a decision to leave
   it parked.
4. The unpushed commit on the canonical World Hub clone's local `main`,
   section 1.
