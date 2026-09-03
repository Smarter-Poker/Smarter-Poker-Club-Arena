# 2026-09-02 — The arena is always the alias

> "THE CLUB ARENA SHOULD ALWAYS 100% OF THE TIME USE THE POKER ALIAS AND NOT
> THE REAL NAME, THE REAL NAME IS USED IN THE WORLD HUB. FIX THE 30 OTHER
> PLACES TO MATCH USE OF POKER ALIAS OVER REAL NAME."

Dan had asked twice before. On 2026-08-23 the resolver was written
(`playerDisplayName`); on 2026-09-02 the club card was pointed at it. Both
times exactly one screen was fixed. This is the sweep.

## It was not thirty places

Ninety-odd, across three layers. The count is the least interesting part — what
matters is that it never looked like a defect anywhere. It looked like
`a || b`, written independently, each instance locally reasonable.

Measured against production before any of this ran:

| what                                                   | count        |
| ------------------------------------------------------ | ------------ |
| profiles whose `display_name` IS their `full_name`     | 264 of 1,308 |
| profiles who opted into `use_real_name`                | **0**        |
| `tournament_players.username` rows holding a real name | 18,873       |
| bad-beat jackpot hits scrolling a real name            | 24 of 29     |
| usernames that are exactly the profile's `full_name`   | 137          |

## Three layers, because the leak was in all three

**The client (about 45 files).** Every service, component and page that renders
a profile name now selects `PLAYER_NAME_COLUMNS` and renders
`playerDisplayName(row)`.

**Postgres (24 functions).** This is the half nobody had looked at. The client
was corrected on 2026-08-23 and the database was not, so it had grown **three
separate name resolvers that disagreed with each other and with the client**:

```
fn_hg_caller_display_name   display_name -> full_name -> username
fn_notify_display_name      username     -> full_name
fn_player_display_name      (use_real_name ? display_name) -> alias -> ...
```

The first two name `full_name` **explicitly** as a fallback, so a home-game
roster or a dispute notification printed a legal name outright. All three are
now thin wrappers over one new `public.fn_arena_name`, which mirrors the
client's arena branch exactly — so their eight callers were corrected without
being touched.

Then the twenty RPCs this repo actually calls. `fn_search_players` was the
sharpest: it **searched** `alias` and **answered** with `display_name`, so Find
Player replied to every query with real names. `fn_my_wallet_ledger` was the
plainest: `coalesce(display_name, username, full_name)` — a player's own
chip-transfer history could caption every counterparty with their legal name.

**Stored snapshots.** Two columns are denormalised and re-displayed forever:
`tournament_players.username` (18,873 rows) and `bbj_winners.*_display_name`
(24 of 29). Correcting a resolver does nothing for rows already written.

## The judgement calls, stated rather than buried

**Horses are renamed, deliberately.** All 1,000 horse rows carry an alias that
differs from their `display_name` (`SqueezeWardenNine` vs `Drake Dunmore`).
Leaving them on person-shaped names while humans moved to handles would make
"has a first and last name" a **perfect horse tell** at every table — exactly
the harm CLAUDE.md 10.5 exists to prevent. Identical treatment, not equivalent.

**Settled history is left alone; live surfaces are not.** The tournament
backfill covers non-`COMPLETED` events only, following the precedent set by
`20260823020000`: a finished result sheet is a settled record, and 10.9 says
correct forward rather than rewrite quietly. The bad-beat ticker is the
opposite case — a live public display that keeps re-showing the same 29 rows —
so those snapshots were corrected. Only display columns changed; every payout
figure is untouched.

**A toggle that could no longer do what it said.** "Use Real Name (Vs Alias)"
sat in both the hamburger and the table menu. It writes
`profiles.use_real_name`, which the **social** branch still honours, so the
preference is real and stays. What changed is its reach: the arena ignores it
now. Rather than leave a switch promising to rename the seat above your stack,
it is relabelled **"Show Real Name On Social"** / **"Social Name"**.

**One thing that looked like a bug and was not.** `bbj_atomic_payout_v2`
assigns `v_winner_name` from `p_loser_user_id`. That reads like a swap; it is
deliberate and consistent — in a bad beat the player who _lost the hand_ is the
one who _wins the jackpot_, and every insert in the function follows the same
inversion. Checked before touching it, and left exactly as it was.

## The quiet half of the bug, and why there is now a law

Converting a render without widening its `select` looks like a fix and is not:
`playerDisplayName` resolves `alias -> username -> display_name`, so a row
fetched as `'display_name, username'` silently degrades to the username — which
is itself the full name on 137 rows.

That happened during this very sweep. `ClubDetailPage`'s render was converted
while its select was not, and it took a repo-wide scan to notice. So
`tests/theArenaIsAlwaysTheAlias.law.test.ts` checks **both** halves, and its
exemption lists are annotated: each entry is a claim that the `display_name` in
question is a chat snapshot, a club nickname, an identity writer, or an RPC
that already resolved it. Anything you cannot classify is the bug.

The three money functions in the last batch (`fn_club_bank_ledger`,
`fn_agent_downline_rake`, `fn_union_settlement_preview`) were rewritten by
**generating** the substitution rather than retyping 45KB of settlement
arithmetic, with an assertion that collapses the result back and refuses to
proceed unless it is byte-identical to the original. A transcription error
cannot survive that; a retype has no equivalent guarantee.

## It was already undone once, within the hour

While this branch was being verified, `20260902214500_player_search_fuzzy_and_affiliations`
landed on main from another branch: trigram search and affiliations for Find
Player, a good change. It replaced the whole of `fn_search_players` and,
having been written against the older body, went back to emitting
`p.display_name`. It was applied to production **after** the fix, so Find
Player was answering with real names again and nothing said a word.

Neither agent did anything wrong locally. That is the point, and it is why a
person cannot be the check: `20260903123000` re-applies the arena name **onto
their definition** — the trigram matching, similarity thresholds and
affiliations are all still there, and the round-trip assertion proves only the
name expression moved — and the law now asserts that the **last** migration to
define `fn_search_players` carries `fn_arena_name`. Whoever rewrites it next
gets told by CI rather than by a player seeing their own legal name in a search
result.

## Verification

- `npx tsc --noEmit` — exit 0
- `npx vitest run` — see the PR run
- Five migrations applied to production, every assertion passing: the resolver
  plus the three legacy functions and `fn_search_players`; the live tournament
  backfill; ten RPCs retyped; ten RPCs generated with the round-trip proof; the
  jackpot ticker.
- Post-apply: `fn_player_display_name(<Dan>)` returns `KingFish`; **0** live
  tournament seats and **0** jackpot hits still show a real name; 24 of 24 Club
  Arena name functions resolve through `fn_arena_name`.

## Still open — recorded, not hidden

1. **Sign-up seeds `display_name` from `full_name`** (`IdentityDNA`,
   `AuthGuard`, `useAuthUser`). That is the mechanism that produced the 264
   rows. Changing what sign-up _stores_ is a decision about the World Hub's
   identity record rather than a rendering fix, so it is written down here.
2. **Three dormant profiles** have no alias, no usable `display_name`, and a
   username that IS their full name. None is seated or has a tournament row.
   Suppressing it would render them nameless while the app still prints
   `@username` beside search results — an inconsistency, not a privacy gain.
   The migration asserts that number cannot grow past three unnoticed.
3. **The `home_game` / `home_group` RPC family** (56 functions) still selects
   `display_name`. This repo calls none of them; they are World Hub surfaces,
   where Dan says the real name belongs. That boundary is why they were left
   alone, and it is worth re-checking if Club Arena ever calls one.
