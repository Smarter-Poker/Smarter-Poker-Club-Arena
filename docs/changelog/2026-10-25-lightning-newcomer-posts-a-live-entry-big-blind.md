# Lightning: A Newcomer Who Cannot Be Held Posts a Live Entry Big Blind

Dan, 2026-10-24, verbatim: "NEW PLAYERS SHOULD ALWAYS BE BB FIRST."

## What Was Still Wrong

`20261024195059` holds a newcomer (a pool slot that has never been the big blind, `lightning_pool_slot.last_bb_at IS NULL`) who is not one of the pass's big blinds, with one exception: `EXIT WHEN v_g2 = 0`. A hold that would leave the pass no hand at all is not taken, so every newcomer is seated anyway. Blind order ranks `last_bb_at` NULLS FIRST, so the second newcomer is next in line and is dealt the small blind.

Measured on the TypeScript port, which is the SQL line for line: two newcomers and three regulars deal one newcomer the small blind; three and three deal two newcomers off the big blind; four and three deal three; the second pass after four newcomers and eight regulars does the same.

Read from production (first dealt hand of every pool slot opened after 20:30 UTC on 2026-10-24, through 05:32 UTC on 2026-10-25): of 877 new slots, 845 were the big blind, 17 the small blind and 15 held no blind. The 32 exceptions came from hands holding on average about three newcomers, which is this case exactly.

## The Decision

When holding would leave the pass no hand, the pass still deals, and each extra newcomer **posts a live big blind from their seat**. This is "post to play", the standard way into a fast-fold pool. Their first hand costs and plays exactly like the big blind: one big blind, live, counted toward their call, and they keep the option. The real big blind is unchanged and nobody else's blind changes. They are stamped like the big blind, so after that hand they are no longer newcomers and are never charged twice.

## The Fix

**`20261025050528_lightning_newcomer_posts_a_live_entry_big_blind.sql`.** md5-guarded text replacements of three live definitions, every anchor exactly once, in one short transaction (`lock_timeout` 1s, `statement_timeout` 8s). It declares no new object.

- `fn_lightning_match_plan`: after the unchanged hold loop, the newcomers the pass seats outside its big blinds are its entry big blinds (`entry_bb` on each group in seat order, `entry_big_blind` on the plan). The small blind comes from the players who are not entry posters first. Only a group with nobody else (a pool of only newcomers) gives it to an entry poster, whose small blind is then dead.
- `fn_lightning_form_hand`: the barrier derives the same set from its own locked blind-order rows (`last_bb_at` NULL, not the big blind) and records each as `blind_role = 'entry_bb'`. It takes the small blind from the others first, stamps every entry poster like the big blind (`last_bb_at`, `hands_since_bb = 0`, `bb_count + 1`) and never stamps a small blind it did not post. Its re-check accepts a dead small blind in seat 1 held by an entry poster, and a replayed formation names seat 1 as `sb`.
- `fn_lightning_instance_releases_its_reservations`: a hand voided before dealing gives an entry poster their stamps and ledger credit back exactly as a big blind's, so a newcomer stays a newcomer.

**`20261025050534_lightning_hand_player_admits_the_entry_big_blind_role.sql`** (`-- @install-window: daily-maintenance`). One `ALTER TABLE` widens `lightning_hand_player_blind_role_check` by exactly `'entry_bb'`, `NOT VALID` (every existing row already satisfies the wider list). It is guarded against a drifted definition. It takes ACCESS EXCLUSIVE for milliseconds on a table every formation writes, so it installs inside the 04:00 freeze.

**The engine.** `LightningHandHost` reads the participant rows. Every `entry_bb` seat goes to HandController's existing `bbOnlyPosts` (a live big blind: bet, pot, counted toward the call, the option). A seat-1 entry poster's small blind is passed as dead (`blindSeats.smallBlind = null`). `checkFormation` refuses any role this host does not deal, so an entry poster is never dealt a free hand. The entry posts join the `blinds_posted` frame so the chips sit in front of the seat and are swept with the street (Animation Law, CLAUDE.md 10.6). `LightningMatcherModel` mirrors the SQL line for line (`entryBb` on every planned group). `LightningRpc` validates `entry_bb` and `entry_big_blind`, and the A/A path replays the database's snapshot under the database's own gate.

## Activation Order

An `entry_bb` participant is dealt correctly only by an engine that posts it. And until the window migration widens the constraint, inserting `entry_bb` is a `check_violation`, which the barrier treats as impossible: it freezes the Cluster. The migrations apply at merge, the window migration at the next 04:00, and the engine at 04:00. So nothing emits `entry_bb` unless a gate inlined into the plan and the barrier says **both**:

1. the request comes from an engine that posts it: PostgREST's `request.headers` carries `x-smarter-lightning-entry-bb: 1`, which only the new engine's Lightning RPC client sends (`LightningSupervisor`, `LIGHTNING_ENTRY_BIG_BLIND_HEADER`); and
2. `lightning_hand_player_blind_role_check` admits `'entry_bb'`.

With either missing, the plan, the barrier and the release trigger behave exactly as before this change. The rule turns on by itself when the last of the three is installed, and off again if the engine is rolled back. There is no config row, no operator flag, and no order to remember.

## Proof

- **PostgreSQL harness** (`scripts/dev/test-lightning-matcher-parity.sh`, new section 13 in `scripts/dev/fixtures/lightning-entry-big-blind-parity.sql`). It runs on the real chain, through production-identical preimages (md5 equal to production for the plan, the barrier, the config, the snapshot and, after `20261024231549`, the release trigger), then both migrations, with the session carrying the engine's header. 13A (two newcomers and three regulars): with the gate closed, the old plan (a newcomer on the small blind); with it open, the real pass and barrier record the second newcomer as `entry_bb` in seat 3 or later beside a regular small blind, stamped like the big blind; the real abandon door gives the stamp and the ledger credit back; and the re-formed hand is dealt and settled by the real terminal path. 13B (a pool of only newcomers): one big blind, five entry big blinds, a dead small blind in seat 1 that the replay names, no small blind stamped. 13C (the second pass after four and eight): the next newcomer is the big blind and the other two post. The TypeScript port agrees on every plan: `PARITY 12 fixtures 28 groups identical`, entry big blinds included. Run here on PostgreSQL 16 (PostgreSQL 17 could not be installed in this environment); CI runs it on 17.
- **Production, read-only.** One Supabase MCP call, one `DO` block, REPEATABLE READ, ending in `RAISE EXCEPTION`. It built the new plan from this migration's own replacement text into `pg_temp`, with the gate forced closed and then open, and ran it beside the live plan for all 15 Lightning clusters at one instant. With the gate closed every plan was identical to the live one, apart from the two additive keys. With the gate open no group changed. No live pool held a newcomer at 05:32 UTC (pools of 0 to 5 legal players overnight), so production could not exercise the entry case there. The harness above does.
- `server/src/lightning/ANewPlayersFirstLightningHandIsTheBigBlind.law.test.ts` pins the rule on every matcher version: 2+3, 3+3, 4+3, an all-newcomer six, the second pass after 4+8, 400 random pools of any mix in which every newcomer is the big blind or posts one and no pass that could deal stalls, the closed gate reproducing the old plan, and the SQL and host text.
- `server/src/lightning/LightningEntryBigBlind.test.ts` pins the deal through HandController. The post comes out of the stack and goes into the pot, and the price for everyone else is unchanged. The poster keeps the option, and a raise costs the raise less the live post. A short poster is all in for less. A seat-1 poster leaves the small blind dead and still acts first after the flop. Unknown roles are refused. Forty seeded hands settle and conserve chips, with the post reaching the books.

Horses are players (CLAUDE.md 10.5): nothing here reads a horse marker. No money moves in SQL: the entry post is the engine's, at the felt, and reaches the books through the hand's settlement like every posted blind.

## Recovered and integrated on October 25

Installs after protected-main conversion-seat migration 20261024213844.
Its exact plan preimage was recomputed on PostgreSQL 17 over the real chain
(definition MD5 f35a6343a51e57c032bde2fcf7372d4b), with matching production
body identity read without writing production. The barrier now snapshots the
same conversion-seat exemption into its locked candidate rows, so it cannot
charge entry posts to existing conversion seats while the plan exempts them.

Both sides of the parity harness conflict remain: the fresh-conversion case
and all entry-post cases. A new mixed thin-pool fixture proves three conversion
seats with no previous big blind are dealt without entry posts beside two true
newcomers. The SQL plan and TypeScript models agree on 14 fixtures and 47 groups
on PostgreSQL 17; real formation, void stamp/ledger restoration and settlement
run. The original migration refuses this predecessor; the repaired one installs.

The secondary shadow model now receives entry posts from the live worker and
counts them in blind history and fairness gaps, with a connected worker test.
It still cannot move chips or control live play. The known clock fixture repair
from PR #7985 is retained so off-turn early looks cannot consume the tank test.

Local focused checks: 82 engine tests and 1,130 client/source checks passed.
Full Lightning checks, exact-candidate hooks, protected checks, migration
installation, certified daily engine activation and live behavior remain
separate requirements; no production installation is claimed by these results.
