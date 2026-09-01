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

## The gate earned its place within the hour

`fn_ca_banned_copy_characters()` went in so the cleanup could not be quietly
undone. It was, within the hour, by four migrations applied after it -
including `fn_ca_incident_notify`, which is a push notification body someone
reads on their phone. `20260831232415` cleaned them. That is the difference
between a cleanup and a rule.

## Then the second half, which the first pass had deferred

The dash migration said Title Casing this copy needed its own pass because it
changes WORDS, not characters, and several strings carry identifiers and `%`
placeholders a blind transform would mangle. Two more migrations did that pass
properly:

- **`20260831234055`** Title Cases 37 player-facing strings from an explicit
  hand-written `old -> new` map. No algorithm touches this copy. Machine codes
  (`NOT_HOST_OR_ADMIN`, `NEW_ACCOUNT_COOLDOWN`) are deliberately excluded -
  they are switch keys the client matches on, and Title Casing them breaks the
  branch that reads them.
- **`20260831234418`** removes the emoji from six player-facing surfaces:
  "You received 500 [gem] from @someone", the four reward popups, the buy-in
  ledger line, the agent cashout notification, the shared-post preview, and
  the new-member welcome. `design-guidelines.md` rule 1 bans emoji outright and
  `check-no-emoji.mjs` cannot see the database either - the same blind spot in
  a second costume. The gate now answers for both bans.

**Two of these migrations failed on their first attempt, and both failures were
the post-check working.** One installed an emoji character class so wide it
reported `->` inside a HINT and `* NEW:` in a comment - a gate that cries wolf
gets deleted by the next agent. The other carried a malformed replacement that
would have written a syntactically broken body into a live messaging function;
Postgres refused it and the whole transaction rolled back, so production never
saw it. That is why each pass is one transaction ending in an assertion rather
than a loop that reports what it managed.

Operator dashboards keep their status glyphs, exempted **by name** in the
function body rather than by a pattern, because a pattern quietly grows to
cover whatever somebody names next.

## Two gaps in how work reaches production, both fixed

Neither is copy, and both were found while trying to ship the copy fixes.

**A green CI run that verified nothing.** Every job in `ci.yml` is gated on
`github.event_name == 'pull_request'`, so a PUSH to main runs nothing and
reports success. Commit `a73ee758` is green on main with "Client Unit Tests:
skipped" and "Server Engine: skipped" - and four tests had been failing on main
underneath that green. They surfaced only because an unrelated PR happened to
touch `tests/`, the one thing that makes the client suite run.

That is defensible on its own terms - the pull request already tested that tree
- but a squash merge builds a tree NO pull request ever tested whenever main
moved in between, which is most merges here. Two fixes:

- a **daily scheduled run against main** with no change detection, which is the
  only thing in that file able to answer "is the branch we deploy from actually
  passing";
- a **`verdict` job** that always runs, writes a table of what ran versus what
  was skipped, and raises a warning annotation when neither suite executed. A
  skipped job and a passing job look identical in `gh run list`; this is the
  same move the Hetzner deploy already makes with its "DID NOT DEPLOY" step.

**A deploy window that a dropped cron could close.** `auto-deploy-hetzner.yml`
restarts only at 18, 22, 04, 10 and 14 Chicago, which is good policy. It fired
**once**, at the top of each candidate hour, and a GitHub scheduled workflow is
best-effort: delayed under load, sometimes dropped. Miss that single tick and
the whole one-hour window closes unused and merged engine code waits four more
hours.

On 2026-08-31 the 23:00 UTC tick never arrived. The engine served the same
build for over three hours with the window standing open, twelve deploy runs
reporting success having shipped nothing, and the insurance fix and the horse
seat-call fix both sitting unlanded. The cron now fires at :00, :20 and :40 of
each candidate hour; the window gate still admits only the five correct local
hours and the dedupe step still returns in seconds once production is current,
so the extra ticks cost nothing and buy two more chances at every window.

## A migration you can prove you committed

`fn_ca_migration_text(version)` returns the exact statements a migration
executed, with an md5. The "Applied Migrations Are Recorded" check found **428
of 820** migrations since 2026-08-24 with no file in the repo, and the reason is
mechanical: an agent applying SQL through the Supabase MCP has no way to read
back what ran, so it retypes the file and the file drifts from production while
looking authoritative. All five migrations in this changelog were committed by
reading their own text back and checking the md5. Read-only, service_role only:
migration history is evidence, and evidence you can edit is not evidence.

## Still open, and named rather than quietly skipped

- **Source comments remain exempt from the em dash ban**, which is the policy
  `check-ui-text` has documented since 2026-08-20. There are roughly 23,000 em
  dashes in comments and docs across ~3,000 files. Rewriting them is
  mechanically safe but an enormous diff that would conflict with every other
  agent's in-flight work, so it is Dan's call rather than an assumption to make
  silently.
- **`bbj_qualifying_hands`, `seeded_content` and `platform_policies`** carry
  violations and are referenced nowhere in the repo. Dead schema, for Phase 6.
- **`feature_pricing.description`** has 70+ lowercase rows and no caller
  selects that column. Unrendered metadata, left alone.
