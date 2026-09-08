# Settling nothing needs no wallet, and level stats stop being a stub

2026-09-08. Three deferred items from the phase 8 deep dive, applied together
in ONE migration and therefore ONE PostgREST schema-cache reload — the phase 8
pair cost eighteen hands precisely because they were two reloads three minutes
apart — and applied **inside the :55 maintenance break**, when every table is
parked at a hand boundary and a reload cannot land on an in-flight hand at all.

`20260908045608_settling_nothing_needs_no_wallet_and_level_stats_stop_being_a_stub`.
Probed in a transaction that was rolled back first (11.5); a rolled-back DDL
transaction delivers no `NOTIFY`, so the probe itself started no reload.

## 1. A departed seat that moved nothing needs no wallet

`fn_ca_settle_hand_stacks_absolute` refuses a hand whole when a seat that has
left cannot be resolved to a club wallet. That is right — that seat's delta has
to be settled somewhere. But it demanded the wallet **before** working out
whether the seat had moved anything.

Hand **7903456**, one of the eighteen the phase 8 reload dropped, is the worked
example: it nets to zero between two players who are both still seated, and it
was refused whole because a _third_ seat, with a delta of **0.00**, had gone.
Nothing needed to be written for that seat and nothing could have been.

The departed loop already skipped a zero delta two steps later
(`IF v_dep.delta = 0 THEN CONTINUE`), so this moves the same decision earlier,
in front of the wallet requirement. A seat that moved chips still needs its
wallet and is still refused without one.

**Applied as an asserted text substitution on the live definition**, not a
retyped body. The function is ~250 lines of money code and retyping it to
change four is how an unrelated line goes missing. The migration reads
`pg_get_functiondef`, requires the anchor to appear **exactly once**, aborts if
it does not, and is a no-op on a second run.

## 2. `get_user_level_stats` stops being a stub

The live one-argument version returned a hard-coded
`{xp:0, level:1, xp_to_next:0, progress_pct:0}` — an XP shape, from a function
named for level statistics, read by a World Hub caller that wants
`{total_questions, correct_answers, accuracy, avg_ev_loss}` per level. That
caller passes `(p_user_id, p_level_id)`, matched no signature, and has answered
PGRST202 since it was written.

**The caller was right, so the database is what changed.** A two-argument
overload computed from `training_answers`, which holds exactly those facts.
Measured in the probe against the busiest user and level: 1,845 questions, 938
correct, 50.84%, average EV loss 0.1486.

`SECURITY INVOKER`, deliberately. RLS on `training_answers` is
`training_answers_select_self`, so a reader sees only their own rows and the
`p_user_id` argument cannot become a way to read somebody else's record. A
DEFINER function would have to re-implement that check, and a check that has to
be re-implemented is a check that eventually is not.

The one-argument stub is left in place: Club Arena's `useArenaStore.loadStats`
still calls it, expecting a _third_ shape again
(`{total_clubs, active_tables, active_players, ...}`). That action has no
caller, so it moves no money and breaks no page. The World Hub side is
`fix/the-rpc-calls-that-never-reached-a-function` and its audit note.

## 3. The meter says what it does not cover

`fn_ca_currency_meter` writes `enforced = true` for VIP points and agent
commissions; only the rakeback row carried a `not_enforced_because`. The two
enforced rows said nothing about their edges, and CLAUDE.md 10.86 is exactly
about a guard that answers confidently on a scope nobody stated.

Its `COMMENT` now names all three tiers: what is **enforced** and why a drift
there is critical; what is **deliberately not enforced** (rakeback, while
`fn_close_settlement_period` is another lane's live rebuild); and what is **not
covered at all** — `vip_points_carry`, the fractional remainder between awards,
which no guard watches, and the commission rollup, which is _compared_ here
rather than guarded, its correctness resting on the statement triggers that
maintain it. The O(journal) cost is stated beside it.

Said as a comment rather than by rewriting a working function for prose.

## Deliberately not done

**`vip_points_ledger` still has no `created_at` index.** It is wanted for the
meter's eventual rotation, and it cannot be built safely right now:
`CREATE INDEX CONCURRENTLY` cannot run inside a migration's transaction, and a
plain `CREATE INDEX` on 5.77M rows holds ACCESS EXCLUSIVE for the build — which
is the phase 8 hazard again, VIP awards failing rather than slowing. The meter's
VIP pass takes 10.2s against job 286's 600s budget and grows ~306k legs a day,
so it has roughly five years of headroom. Building it belongs with a maintenance
window and a `CONCURRENTLY` path, not with this.
