# The Copy Rules Reach The Engine And The Database

2026-08-31.

Dan: "make sure the first letter of every word on every single page and sub
page is capitalized and remove any and all m bars as they are banned from use."

By this morning the product already had five gates for those two rules:
`check-ui-text`, `check-title-case`, `check-painted-text-case`,
`check-nav-title-case` and `check-no-emoji`. All five were green. So the
useful question was not "is the rule broken" but "what does no gate look at,
and does a player read it".

Two answers, and both were live.

## 1. The engine, where the capitalisation rule stopped at the client

`check-ui-text` walks `server/src`. It made that move on 2026-08-31 with a
note worth repeating: "A list of the files somebody happened to check is a
cleanup. The directory is the gate." `check-title-case` never made it, so it
walked `src/` and stopped. Pointing it at `server/src` found thirteen live
strings, and the interesting part is which ones.

Twelve of them are the BBJ qualifying rules in `server/src/config/RakeConfig.ts`
- the body text of the Bad Beat Jackpot panel. The client renders that panel
from its OWN copy of the same table in `src/config/RakeConfig.ts`, and the two
files are meant to mirror each other. The client's copy had been Title Cased
by the gate months ago. The server's had not, because nothing looked. They had
drifted apart, and the drift was invisible **precisely because a gate was
passing**:

```
client   'Full House (Aces Full Of Jacks) Or Better Must LOSE To Quads Or Straight Flush'
server   'Full House (Aces full of Jacks) or better must LOSE to Quads or Straight Flush'
```

The thirteenth is the push notification title a player gets when the jackpot
pays them: `'Bad Beat Jackpot - you got paid!'`.

Fixed by widening the walk and running `--fix`. Every BBJ description in the
engine is now byte-identical to the client's, and a test asserts that
continuously rather than trusting it.

The widening also stopped the gate reading `*.test.ts` files as page copy.
`__tests__` was already skipped as a directory, but this codebase keeps its
tests beside the source, so fixture labels (`'test'`, `'$5 -> 1 seat'`) were
being reported as violations.

## 2. The database, which no gate can see at all

Every one of the five gates reads FILES. A Postgres function hands its `RAISE`
message, and its `jsonb_build_object('message', ...)`, straight to the client,
which toasts it verbatim. Nothing was reading that surface.

**120 public functions were serving banned dash characters to players.** A
sample of what production was actually saying while all five gates reported OK:

| Function | Copy |
|---|---|
| `check_username_with_suggestions` | "Username must be 3-20 characters ..." (en dash), callable by `anon` - this is the signup screen |
| `claim_social_profile` | "Your profile row is missing - refresh and try again." |
| `process_tournament_rebuy` | "No live seat for this % - refusing to charge for chips ..." |
| `fn_cancel_cashout` | "Cashout cancelled - chips returned" |
| `redeem_referral_code` | "Referral reward - new player joined with your code" |
| `fn_mint_club_chips` | "Chip Mint is revoked for clubs in a union - ..." |
| `fn_notify_home_rsvp`, `fn_send_home_game_reminders` | push notification titles and bodies |

This is the Phase 3 insurance finding wearing a different hat: a green gate is
evidence about the gate, not about the product.

Migration `20260831202752_the_em_dash_ban_reaches_the_database` rewrites every
one of them by taking each function's own `pg_get_functiondef` and translating
the four dash characters to a plain hyphen. Same signature, same body, same
OID - `CREATE OR REPLACE`, so every trigger, grant and dependency survives.

Two things made that safe enough to run against production money paths:

- A dash inside a regex character class WOULD change meaning: `[--]` is a
  valid, meaningless range, and that is exactly how a `--fix` run once
  disabled `check-ui-text`'s own stripper. So the migration refuses to run at
  all if any function holds one. It checked: zero. Every one of the 120 sits
  in a message literal or a comment.
- The whole rewrite was run first inside a transaction that was **ROLLED
  BACK**: 120 rewritten, 0 failures, 0 remaining. Production was untouched
  until that came back clean.

`fn_ca_banned_copy_characters()` stays behind as the database's own copy of
`check-ui-text`, and `scripts/ci/check-db-copy.mjs` reads it from the
cron-health workflow - the one place that already holds service-role
credentials, and the one workflow whose whole job is asking production what is
true rather than asking the source what it claims.

The checker is exempt from its own rule, in all three places it needs to be
(the pre-flight, the rewrite loop, and its own query). Without that, the loop
translates its character class into `[----]` on the next run and the gate
silently disables itself.

## What was checked and found clean

- **Every catalog table the client actually reads.** `bbj_stakes_tiers`,
  `ca_rake_tier`, `daily_challenge_milestones`: no banned characters, correct
  casing.
- **`feature_pricing.description`**, 70+ lowercase rows - traced every reader
  first. Every call site selects `feature` and `diamond_cost`; nothing selects
  `description`. Unrendered metadata, not copy, so it was left alone.
- **`bbj_qualifying_hands`**, whose rows are not Title Cased - grep finds no
  reference to that table anywhere in the repo. Dead schema, recorded for
  Phase 6 rather than rewritten.
- **`seeded_content`** (4 rows) and **`platform_policies`** (3 rows) carry em
  dashes and are likewise referenced nowhere. Same disposition.
- **`supabase/functions/`** - one em dash, in a comment, in
  `send-push-notification/index.ts`. That line also carries an emoji, which
  `design-guidelines.md` rule 1 bans outright; recorded, not fixed here.

## Still open, and named rather than quietly skipped

- **The database copy is not Title Cased.** The same messages the migration
  de-dashed still read "Username must be 3-20 characters", not "Username Must
  Be 3-20 Characters". Title casing changes WORDS, and several of these
  strings carry identifiers (`atomic_table_buyin`, `splitBuyIn`) and `%`
  format placeholders that a blind transform would mangle. `check-title-case`
  is AST-aware for exactly that reason. The database copy needs the same care
  and gets its own pass rather than a `translate()`.
- **Source comments remain exempt from the em dash ban**, which is the policy
  `check-ui-text` has documented since 2026-08-20. There are roughly 23,000
  em dashes in comments and docs across ~3,000 files. Rewriting them is a
  mechanically safe but enormous diff that would conflict with every other
  agent's in-flight work, so it is Dan's call, not an assumption to make
  silently.
