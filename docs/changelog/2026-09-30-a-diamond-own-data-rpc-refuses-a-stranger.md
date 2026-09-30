# A Diamond Own-Data RPC Refuses A Stranger, The Arena Plate Agrees With The Switch, And The Law Reads What Production Ran

2026-09-30. Three defects from a deep-dive audit of the diamond-wallet
database layer. One migration, `20260930054954`, for the first two and the
label; a repo-file reconciliation, with no DDL at all, for the third.

Nothing here touches `profiles.diamonds`, any grant writer, any settled
record, or either arena switch.

---

## 1. `fn_diamond_lifetime_totals` answered `0` where it could not tell

### The cause

Four functions answer a question about one player's diamonds. Three of them
refuse a caller who is neither the subject nor `service_role`, by name, with
SQLSTATE `42501`: `wallet_summary_is_own_only`, `diamond_flow_is_own_only`,
`arena_reconciliation_is_own_only`. Each refusal was exercised against
production before this change and each one fired.

The fourth, `fn_diamond_lifetime_totals`, had no guard at all. It is
`SECURITY INVOKER`, plain SQL, `p_user_id uuid DEFAULT auth.uid()`, `EXECUTE`
to `authenticated`. Its four figures are `COALESCE(..., 0)` sums over rows RLS
would not show a stranger, so a caller naming somebody else's id got a
well-formed answer of four zeros:

```sql
SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"<other user>"}', true);
SET LOCAL ROLE authenticated;
SELECT * FROM public.fn_diamond_lifetime_totals('47965354-0e56-43ef-931c-ddaab82af765');
-- lifetime_earned 0 | lifetime_spent 0 | credits 0 | debits 0
```

That wallet holds 613,595 earned and 132,320 spent.

No money leaked. RLS policy `diamond_transactions_select_own` held the whole
time, which is exactly why this was quiet: the failure is not disclosure, it
is a confident zero that a surface prints as "Total Earned 0". Four zeros are
indistinguishable from a brand-new account. CLAUDE.md 10.86 rule 1 - "I could
not tell" is a distinct outcome and must have its own name - and rule 2 -
never coerce an unreadable answer into an empty one.

### What changed

The siblings' guard, word for word, with this function's own error name
`lifetime_totals_is_own_only`. The language moves from `sql` to `plpgsql`
only because a guard has to be able to `RAISE`; the signature, the four
output columns and the sums are unchanged, and it stays `SECURITY INVOKER`
so RLS is still what scopes the rows.

**Every caller was read first, on `origin/main` in both repos, before the
guard was written.** `service_role` must keep naming a user, and it does:

| Caller                                              | How it calls                                                                           | After                                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/services/DiamondService.ts` `getLifetimeStats` | browser, `authenticated`, `{ p_user_id: <signed-in user> }`                            | unchanged                                                                                                |
| World Hub `pages/api/store/diamond-transactions.js` | service-role client, `{ p_user_id: userId }` (JWT-verified subject, never `req.query`) | unchanged; the role branch is what lets it name a user                                                   |
| `fn_diamond_wallet_summary`                         | `SELECT * INTO v_lifetime FROM public.fn_diamond_lifetime_totals(v_user)`              | unchanged; its own guard has already pinned `v_user` to `auth.uid()` unless the caller is `service_role` |
| `scripts/ci/diamond-wallet-live-smoke.mjs`          | authenticated, own id                                                                  | unchanged                                                                                                |

### The pin

`tests/a-diamond-own-data-rpc-refuses-a-stranger.law.test.ts`, with
`docs/laws.d/a-diamond-own-data-rpc-refuses-a-stranger.md`. It reads the
LATEST migration declaring each of the four and requires all four to carry
`authentication_required`, the one shared
`v_role <> 'service_role' AND v_user IS DISTINCT FROM auth.uid()` expression,
and their own refusal name - so the next own-data RPC cannot ship without one,
and none of the four can drift into a looser test than the other three.

---

## 2. The Arena plate contradicted itself

### The cause

`fn_diamond_wallet_summary` computed `open_cash_tables`, `min_cash_buy_in` and
`cheapest_table` without ever consulting `cash_games_enabled`, so one read
said two opposite things:

```json
{
  "cash_games_enabled": false,
  "tournaments_enabled": false,
  "open_cash_tables": 17,
  "min_cash_buy_in": 80,
  "cheapest_table": { "name": "NLH 1/2", "small_blind": 1.0, "big_blind": 2.0 }
}
```

### Which source is authoritative: the switch

Read live before deciding. `ca_arena_settings` row 1 has `cash_games_enabled`
false and `tournaments_enabled` false, last updated 2026-09-08. The 17 tables
are real rows - the Diamond Arena's pre-provisioned stake ladder, NLH 1/2 up
to NLH 5000/10000, all created 2026-09-11 23:07:38 UTC and all still
`waiting`.

They are not open. `cash_games_enabled` is the admission switch, and the only
two doors that fund a Diamond seat both enforce it: `fn_poker_diamond_buyin`
and `fn_poker_diamond_top_up` are the only functions in the whole
`fn_poker_diamond_*` family whose bodies read it (`fn_poker_diamond_reserve`
and `fn_poker_diamond_tournament_charge` read the tournament switch). While it
is false, every one of those 17 tables refuses a buy-in by name. A table
nobody can sit at is not an open table, so the count was the thing that was
wrong, not the flag.

### What changed

The cheapest-seat scan is now gated on the switch. Closed means
`open_cash_tables` 0, `min_cash_buy_in` NULL, `cheapest_table` NULL, and the
17-predicate scan does not run at all. Open the switch and the same three
fields answer exactly as they do today. The two flags themselves are still
reported as they are, so the surface can keep saying "Diamond Arena Opens
Soon".

**No client behaviour changes today**, which was checked rather than assumed.
`PlayerWalletPage` already gates both the cheapest-seat sentence and the Sit
Down control on `arenaOpen = cashGamesEnabled || tournamentsEnabled`, so it
never printed the contradictory figures; the World Hub route reads only the
two flags (`arenaOpen`). This makes the RPC agree with its surfaces instead of
relying on every future reader to remember the rule. Nothing starts offering a
seat, and nothing that was offered is withdrawn.

### The pin

`tests/unit/theArenaPlateAgreesWithTheSwitch.test.ts`: one gate, on the scan,
in the latest migration declaring the function; the two seat figures NULL when
the gated scan found nothing; the flags still reported as they are; and the
wallet surface still reading the seat figures only behind `arenaOpen`.

---

## 3. The phase-6 law pinned a migration production never ran

### The cause

Two files on `main` shared one base name:

- `supabase/migrations/20260920142916_the_ledger_speaks_to_the_player.sql`, 246 lines
- `supabase/migrations/20260920143152_the_ledger_speaks_to_the_player.sql`, 192 lines

`diff` says they are identical but for a 54-line header on the first.
`supabase_migrations.schema_migrations` has exactly one of them:

```sql
SELECT version, name FROM supabase_migrations.schema_migrations
WHERE version IN ('20260920142916','20260920143152');
-- 20260920143152 | the_ledger_speaks_to_the_player
```

`20260920142916` was reserved, written, and never applied - the same change
went in twenty-three minutes later under the second version, and the first
file was left behind. `tests/the-ledger-speaks-to-the-player.law.test.ts:23`
hard-coded the un-applied one, so the law guarded a file production never ran
and an edit to the applied twin left it green.

### What changed, and why the applied file was not edited

`20260920143152` is byte-exact to what production executed. Verified again
today: `md5` of the file on disk is `4dc6541aeb52caf131c824fc8e800608`, equal
to
`md5(convert_to(array_to_string(statements, E'\n') || E'\n','UTF8'))`
for that version, 13,960 bytes both sides. That exactness is the file's whole
value (it is the record `docs/changelog/2026-09-22-the-repo-can-be-made-to-match-the-database.md`
recovered), so **the applied file is not touched** - not even to receive the
better header.

So: `20260920142916` is deleted; its header's reasoning, which is the better
record, is preserved here and in the phase-6 changelog it belongs to; and the
law stops hard-coding a path. It now resolves the LATEST migration that
declares each of the three functions it guards - the same `latestDeclaring`
shape the sibling `tests/the-route-and-the-client-agree.law.test.ts` already
uses - so it cannot go stale again, and it reads this branch's new definition
of `fn_diamond_kind_row_label` rather than a file from ten days ago.

`docs/changelog/2026-09-20-phase-6-the-ledger-speaks-to-the-player.md` and
`scripts/ci/schema-manifest.d/cw-wallet-the-ledger-speaks-to-the-player.json`
both said "applied as 20260920142916". Both are corrected in place with a
dated note; neither claim was true.

**No migration was applied and no DDL was run for this item.** It is a
repo-file reconciliation, confirmed by `SELECT` first.

---

## 4. Four players were shown the operator string "Test Entry"

`fn_diamond_kind_row_label` mapped `k LIKE 'test%'` to `'Test Entry'`. Four
production rows render it to a player today:

| kind          | amount | description                                     | created    |
| ------------- | ------ | ----------------------------------------------- | ---------- |
| `test_verify` | +1     | Pipeline verification test after constraint fix | 2026-02-21 |
| `test`        | +1     | test                                            | 2026-05-06 |
| `test_ref_id` | -1     | Test deduct                                     | 2026-05-17 |
| `test_ref_id` | -1     | Test deduct                                     | 2026-05-17 |

They are real one-Diamond corrections, so they take the label the platform
already uses for a correction: **Balance Adjustment**, the same label
`adjustment`, `reconciliation`, `admin` and `admin_grant` carry. Title Case,
no em dash. No row is rewritten - the journal is append-only and these are
settled records; only the label the function computes for them changes.

It rides in the same migration because that migration was already open, and
the ledger law is what pins it: `found` may not contain `Test Entry`, and
`LIKE 'test%'` must map to `Balance Adjustment`.

---

## What was deliberately not changed

- **`profiles.diamonds` and every grant writer.** Another task owns a balance
  drift defect in this repo; nothing here reads or writes either.
- **Either arena switch.** `cash_games_enabled` and `tournaments_enabled` stay
  false. Only a person moves them
  (`tests/only-a-person-moves-the-arena-switches.law.test.ts`).
- **The 17 arena tables.** They are correct rows waiting on the switch.
- **`tests/unit/theWalletLearnsTheDiamondArena.test.ts`.** Its fixture feeds
  the client mapper a closed arena with 17 tables, which the RPC can no longer
  emit. It tests the MAPPER's number handling, not the SQL, and the mapper must
  keep mapping whatever it is handed; rewriting the fixture would weaken a test
  that is doing its own job correctly.
- **The `is_horse` flag.** Horses are players (10.5). None of these three
  functions has ever taken an include/exclude parameter and none gains one.
