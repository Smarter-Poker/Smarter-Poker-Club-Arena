# Five that answer wrongly, and two that turned out to be fine

2026-09-08. Migration `20260908144801_five_that_answer_wrongly.sql`.

The remaining findings from the adversarial review. Four were settled in the
migration before this one; these are the rest.

## Two were not defects, and saying so is part of the job

A fix applied to something already correct is a change with no upside and a real
cost, so both were measured rather than assumed:

- **`fn_ca_diamond_engine_spent` "disagrees with the journal by 1,836,311."** It
  is the frozen baseline plus the journal, by design. The baseline accounts for
  the difference **exactly**, on all 34 period-engine rows. No change.
- **"The RAISE in `fn_ca_diamond_offledger_float` is unreachable."** It fires
  when `fn_ca_arena_diamonds()` returns NULL, which is a real outcome distinct
  from the function being absent - and refusing to publish a balance it could not
  compute is the point of the function. No change.

## The five that were real share one shape

Something answers, and the answer does not depend on what it claims to. That is
CLAUDE.md 10.86, and it is now the estate's characteristic failure.

### 1. A predicate that answered differently depending on who asked

`fn_ca_is_cert_account` was SECURITY INVOKER. Its twin
`fn_ca_is_fixture_account` - same job, written beside it - is DEFINER. The
function reads `auth.users`, which `authenticated` cannot select from, so asked
by service_role it answered correctly and asked through any player-facing path
the `auth.users` arm contributed nothing and the answer silently changed. Eleven
functions consult it, including the collusion scan.

**This is the second time these two disagreed in one day.** The morning's fix
taught one of them that a horse is a player and missed the other. That is what
having two of anything costs, and it is why the migration asserts they now share
a `prosecdef` rather than just fixing the one.

### 2. A budget that refuses nobody but reads as a limit

Ruling 21 took the platform budget out of every refusal path.
`diamond_reward_budgets.budget_diamonds` therefore stops nothing - yet three of
its rows were visibly wrong, and one was worse than wrong:

- `2026-10 / club_arena_daily` held **9,223,372,036,854,775,807** - bigint max,
  somebody's "unlimited" sentinel.
- `2026-10 / daily_challenges` is 100,000 against a September actual of
  1,836,311.
- `2026-09 / daily_missions` was already at 130,305 against 30,000, and nothing
  said so.

**The sentinel was not sitting quietly in a column.** `fn_ca_diamond_trial_balance`
sums that column, so the one report a person reads to see whether the diamond
books are sound was printing

> 34 budget lines, **9223372036867275807 budgeted**, 2371393 spent by players

and had been since 2026-09-07. It now reads `12500000 budgeted`.

`NOT NULL` is what forced the sentinel to exist: there was no way to say "no
plan" except to write a number meaning "ignore this number". The column is
nullable now, the sentinel is NULL, and a CHECK stops another being written.

**The other two numbers were left alone.** What an engine is budgeted to issue
next month is what players will be offered, and 10.9 reserves that to Dan. What
is mine is making the gap impossible to miss, so `fn_ca_diamond_budget_reality`
states every budget against what that engine actually issued and says which are
fiction:

```
2026-10 daily_missions    30000       0  FUTURE PLAN BELOW PAST ACTUAL...
2026-10 daily_challenges 100000       0  FUTURE PLAN BELOW PAST ACTUAL...
2026-10 club_arena_daily   (null)     0  NO PLAN SET. Refuses nobody either way...
2026-09 daily_missions    30000  130305  ALREADY OVER: 4.3x. The plan is fiction.
```

### 3. An append-only ledger that nothing kept append-only

`ca_diamond_engine_spend` replaced a single running total whose row lock
serialised the platform and lost 5,861 awards in one morning. It is the register
of engine spend and is only trustworthy if immutable; nothing enforced that. A
`BEFORE UPDATE OR DELETE` trigger does now, and the migration proves it by
attempting an UPDATE and requiring the refusal.

### 4. A retired rule's incidents that no instrument could see

297 `DR7:engine_over_budget` incidents belong to a rule ruling 21 removed from
`ca_diamond_rule_modes`. The flip forecast joins **from** the rule table, so
those were invisible to it - not reported as retired, simply absent. Silence and
"nothing to report" were the same reading again.

The forecast now names a retired rule that still holds incidents. **On its first
run it found twelve of them**, not one. The rows stay: they are history, and
history is not tidied away (10.9).

### 5. Two copies of the horse claim loop

`record_daily_challenge_event` (6 args) and its `_serialized_body` (5 args) each
carry their own copy. They agree - the previous migration patched both - and
nothing could have noticed if they stopped.

**They are not merged, and the reason is not that it is hard.** That path is how
759 unclaimed rewards came back the same afternoon; restructuring it and the
settlement on one day is how a good change becomes an incident. **Merging them is
owed work and is recorded here as owed.**

Until then `fn_ca_normalise_claim_loop` reduces a body to just its loop, cut at
`END LOOP`, self-names collapsed to `SELF`, comments stripped, whitespace
collapsed - and an assertion requires the two to be identical after that. Getting
this right took three attempts, and each failure was informative:

- comparing raw text failed, because each copy **correctly** names itself in the
  incident it files;
- comparing to end-of-body failed, because past `END LOOP` each copy closes a
  different enclosing function;
- and the final version also checks the loop still pays, still matches the cap
  precisely, and still exits - so a loop emptied of its body cannot pass.

An assertion that fails on differences that are correct is noise, and noise is
what teaches the next agent to weaken the assertion.

## Verified live

```
cert_secdef           true    (matches its twin)
sentinels             0       trial balance now reads 12500000, not 9.2 quintillion
append_only_trigger   1
retired_visible       12      rules holding incidents the forecast could not see
loops_identical       true
identity_ok           true    players + float = register
```
