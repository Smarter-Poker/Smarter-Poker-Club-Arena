#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/accounting-delivery-test.XXXXXX")
started=0
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -f "$fixture/server.log" ]; then
    cat "$fixture/server.log" >&2
  fi
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" \
  -o "-k $fixture/socket -p 55487 -h ''" start >/dev/null
started=1
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55487 -d postgres \
  -f "$root/tests/fixtures/accounting-delivery/bootstrap.sql" \
  -f "$root/tests/fixtures/accounting-delivery/baseline.sql" \
  -f "$root/supabase/migrations/20260914113214_accounting_transfers_deliver_one_invoice_message_and_notification.sql" \
  -f "$root/supabase/migrations/20260914113315_transaction_receipts_require_a_source_and_preserve_issued_figures.sql" \
  -f "$root/tests/fixtures/accounting-delivery/regression.sql"

# The same private cluster owns the two maintained Diamond probes. A separate
# database preserves the accounting test's original fixture and starting state.
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55487 -d postgres <<'SQL'
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='postgres') THEN
   CREATE ROLE postgres SUPERUSER LOGIN;
 END IF;
END $$;
CREATE DATABASE diamond_games_probe OWNER postgres;
SQL
diamond="$root/tests/fixtures/accounting-delivery/diamond-games"
diamond_psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55487 -U postgres -d diamond_games_probe)
# Match the original database-owner trigger context; client identities remain
# synthetic authenticated claims, never a service-role override in the probes.
# Catalog timestamp witnesses are captured in UTC, independent of the runner host.
export PGOPTIONS='-c statement_timeout=90000 -c lock_timeout=2000 -c timezone=UTC'
"${diamond_psql[@]}" \
  -f "$diamond/schema.sql" -f "$diamond/auth.sql" \
  -f "$diamond/functions.sql" -f "$diamond/constraints.sql" \
  -f "$diamond/policy.sql" -f "$diamond/seed.sql" \
  -f "$diamond/play-schema.sql" -f "$diamond/play-functions.sql" -f "$diamond/crash-functions.sql" -f "$diamond/play-seed.sql" \
  -f "$diamond/triggers.sql" -f "$diamond/play-triggers.sql" -f "$diamond/crash-triggers.sql" \
  -f "$root/supabase/migrations/20260917181739_plinko_per_drop_choices.sql" \
  -f "$root/supabase/migrations/20260917181743_crash_cashout_keeps_the_clicked_multiplier.sql" \
  -f "$root/supabase/migrations/20260914100738_a_funding_replay_belongs_to_the_same_request.sql" \
  -f "$root/supabase/migrations/20260914132533_a_claimed_tenth_day_bonus_carries_one_mint_funded_spin.sql"

# The original money path keeps its actual invoice/delivery triggers. Load only
# the captured dependencies needed by the bank fallback regression, never stubs.
"${diamond_psql[@]}" \
  -f "$diamond/invoice-schema.sql" -f "$diamond/union-clubs-schema.sql" \
  -f "$diamond/invoice-functions.sql" \
  -f "$diamond/invoice-constraints.sql" -f "$diamond/invoice-seed.sql" \
  -f "$diamond/invoice-triggers.sql" -f "$diamond/union-clubs-triggers.sql"

"${diamond_psql[@]}" -f "$diamond/wheel-v2-dependencies.sql" \
  -f "$diamond/wheel-v2-current-preimages.sql" \
  -f "$root/supabase/migrations/20260917202351_diamond_wheel_twelve_prizes_and_funded_game_awards.sql"

"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-before.jsonl"
funding_status=0
"${diamond_psql[@]}" -f "$root/tests/sql/diamond-games-funding-identity.sql" \
  > "$fixture/funding.stdout" 2> "$fixture/funding.stderr" || funding_status=$?
cat "$fixture/funding.stdout" "$fixture/funding.stderr"
expected_funding='ERROR:  PROBE PASS (rolled back): union: one journal leg, exact replay accepted, amount, host and operator changes refused; club: one journal leg, exact replay accepted, amount, host and operator changes refused;'
if [ "$funding_status" -ne 3 ] ||
   [ "$(grep -c 'ERROR:' "$fixture/funding.stderr")" -ne 1 ] ||
   ! grep -Fq "$expected_funding" "$fixture/funding.stderr" ||
   grep -Eq 'WARNING:|FATAL:|PANIC:' "$fixture/funding.stderr"; then
  echo 'Diamond funding probe did not reach its exact rollback terminal' >&2
  exit 1
fi
"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-after-funding.jsonl"
cmp "$fixture/diamond-before.jsonl" "$fixture/diamond-after-funding.jsonl"

daily_status=0
"${diamond_psql[@]}" -f "$root/tests/sql/diamond-spins-claimed-daily-bonus.sql" \
  > "$fixture/daily.stdout" 2> "$fixture/daily.stderr" || daily_status=$?
cat "$fixture/daily.stdout" "$fixture/daily.stderr"
expected_daily='NOTICE:  PASS milestones 9/10/11/19/20/29/30/31/40, chest preserved, preview, claim required, duplicate claim, foreign user, canonical Mint refusal, entry=100, player cost=0, host funding, exact replay, welcome independent and once only, private permissions'
if [ "$daily_status" -ne 0 ] ||
   [ "$(grep -Fc "$expected_daily" "$fixture/daily.stderr")" -ne 1 ] ||
   grep -Eq 'ERROR:|WARNING:|FATAL:|PANIC:' "$fixture/daily.stderr"; then
  echo 'Diamond daily-spin probe did not reach its exact rollback terminal' >&2
  exit 1
fi
"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-after-daily.jsonl"
cmp "$fixture/diamond-before.jsonl" "$fixture/diamond-after-daily.jsonl"
echo 'PASS: both Diamond probes reached their complete terminal and all public/auth rows rolled back'

# New game regressions require their exact success witness and all-row rollback.
run_game_probe() {
  local name="$1" expected="$2"
  "${diamond_psql[@]}" -f "$root/tests/sql/$name.sql" > "$fixture/$name.stdout" 2> "$fixture/$name.stderr"
  cat "$fixture/$name.stdout" "$fixture/$name.stderr"
  if [ "$(grep -Fc "$expected" "$fixture/$name.stderr")" -ne 1 ] || grep -Eq 'ERROR:|WARNING:|FATAL:|PANIC:' "$fixture/$name.stderr"; then
    echo "$name did not reach its complete success witness" >&2
    exit 1
  fi
  "${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/$name-after.jsonl"
  cmp "$fixture/diamond-before.jsonl" "$fixture/$name-after.jsonl"
  echo "PASS: $name and all money legs rolled back"
}

# --- D3 settlement burn and quiet ledger 2026-09-21 --- (R17 half; the burn half is appended after the last Diamond entry)
# The captured roster predates 20260921052548. Install that gate, reproduce the
# latent refusal it causes for every authenticated Diamond Spins prize on a union
# host (and what the per-prize documents looked like), then close both at the
# root: the document trigger no longer fires for a Diamond Spins ledger category
# (owner ruling 2026-09-21 R17). Every later probe runs on the quiet ledger.
"${diamond_psql[@]}" -f "$diamond/quiet-ledger-dependencies.sql"
run_game_probe diamond-spins-quiet-ledger-before 'NOTICE:  PASS Quiet ledger reproduction: the gated roster refuses every authenticated union prize (player and owner) with accounting_invoice_recipient_missing, and the engine-paid union prize still issues one document, two Messenger invoices, two notifications and two pushes'
"${diamond_psql[@]}" -f "$root/supabase/migrations/20260921202827_diamond_spins_prize_legs_keep_their_ledger_rows_and_issue_no.sql"
"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-before.jsonl"
run_game_probe diamond-spins-quiet-ledger 'NOTICE:  PASS Quiet ledger: five Diamond Spins categories named once, union and club, promo and bank legs paid to an authenticated player and by the owner with exact chip_ledger, chip_transactions and union wallet rows and zero documents, messages, notifications or pushes; a non-Diamond leg still documents'

# Promo-first and exact Main Bank shortfall for all four game payout categories.
bank_status=0
"${diamond_psql[@]}" -f "$root/tests/sql/diamond-games-bank-fallback.sql" \
  > "$fixture/bank.stdout" 2> "$fixture/bank.stderr" || bank_status=$?
cat "$fixture/bank.stdout" "$fixture/bank.stderr"
expected_bank='NOTICE:  PASS Diamond Main Bank fallback: Union and Club, Promo first, exact shortfall, four game categories, balanced journals, no documents, messages or notifications (owner ruling 2026-09-21 R17), host isolation, atomic insufficient cover'
if [ "$bank_status" -ne 0 ] ||
   [ "$(grep -Fc "$expected_bank" "$fixture/bank.stderr")" -ne 1 ] ||
   grep -Eq 'ERROR:|WARNING:|FATAL:|PANIC:' "$fixture/bank.stderr"; then
  echo 'Diamond Main Bank probe did not reach its exact rollback terminal' >&2
  exit 1
fi
"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-after-bank.jsonl"
cmp "$fixture/diamond-before.jsonl" "$fixture/diamond-after-bank.jsonl"
echo 'PASS: Diamond Main Bank payout rows rolled back'

run_game_probe diamond-plinko-denominations 'NOTICE:  PASS Plinko denominations: nine choices, Double Down, exact drop budget, sealed outcomes, owner custody, Promo payout, replay and invalid allocation rollback'
run_game_probe diamond-wheel-funded-awards 'NOTICE:  PASS Wheel v2: twelve fixed outcomes, exact model, sealed Upgrade, owner custody, inventory, prepaid four-game budgets, Double Down, replay identity, reserved cover, claimed Mint entry, independent welcome and private authority'

# Qualify the additive contract after the historical v2 probe.
"${diamond_psql[@]}" -f "$root/supabase/migrations/20260917210401_diamond_wheel_upgrade_adds_four_instant_chip_prizes.sql" -f "$diamond/wheel-v3-history-dependency.sql"
"${diamond_psql[@]}" -f "$diamond/wheel-guard-dependencies.sql" \
  -f "$root/supabase/migrations/20260918230314_the_profile_guard_admits_ledgered_diamond_wheel_spins.sql"
"${diamond_psql[@]}" -f "$root/supabase/migrations/20260919034436_diamond_spin_half_value_prizes_and_protected_bonus_minimums.sql"
"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-before.jsonl"
run_game_probe diamond-wheel-upgrade-eight 'NOTICE:  PASS Wheel v3: twelve primary and eight weighted Upgrade prizes, exact model, 2500-chip top payout, minimum exposure and real cover, prepaid games, original-entry Double Down, private authority, replay, Mint entry and welcome'

# Old zero-minimum open rounds remain valid after the new settlement contract.
run_game_probe diamond-crash-clicked-multiplier 'NOTICE:  PASS Crash clicked multiplier: exact 2.57x, no late rescue, auto and cap preserved, future and foreign requests refused, one payout on replay'
run_game_probe diamond-bonus-minimum-wins 'NOTICE:  PASS Bonus minimum wins: exact reported Crash award, authenticated start, full immutable minimum, exact257cashout, Mines and Crossing wins, Promo first and Main Bank shortfall, replay'

# Replays use real settled games and the canonical social writer in isolation.
"${diamond_psql[@]}" -f "$diamond/replay-social-dependencies.sql" \
  -f "$diamond/replay-public-guard-dependencies.sql" \
  -f "$root/supabase/migrations/20260919152603_diamond_bonus_replay_and_daily_spin_custody.sql" \
  -f "$root/supabase/migrations/20260919153418_public_bonus_replay_has_an_explicitly_public_reader.sql"
"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-before.jsonl"
run_game_probe diamond-bonus-replays 'NOTICE:  PASS Bonus replays: eight actual normal/Super settlements, private open and foreign refusal, exact payloads and 257cashout, slow100x, scoped cursor, random public snapshot, stable token, one canonical post/story/reward and unchanged game wallets'

# Daily owner settlement is additive after the preserved original custody probes.
"${diamond_psql[@]}" -f "$diamond/daily-custody-dependencies.sql" \
  -f "$diamond/daily-custody-preimages.sql" \
  -f "$root/supabase/migrations/20260919152614_diamond_spin_daily_net_settlement.sql"
"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-before.jsonl"
run_game_probe diamond-daily-custody 'NOTICE:  PASS Daily Diamond custody: real wheel prizes and Double Down, claimed Mint entry only, welcome, canonical supply, negative backing, owner isolation, one closed-day transfer and notification, replay and atomic rollback'

# Immediate bonus admission is qualified after daily custody, on its exact preimage.
"${diamond_psql[@]}" -f "$root/supabase/migrations/20260919172312_wheel_bonuses_must_finish_before_another_spin.sql"
"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-before.jsonl"
run_game_probe diamond-bonus-replays 'NOTICE:  PASS Bonus replays: eight actual normal/Super settlements, private open and foreign refusal, exact payloads and 257cashout, slow100x, scoped cursor, random public snapshot, stable token, one canonical post/story/reward and unchanged game wallets'

# One setting per game and the Super guarantee are qualified last, on the exact
# production preimages of every starter, quote and receipt they patch.
"${diamond_psql[@]}" -f "$root/supabase/migrations/20260919220610_diamond_bonus_games_have_one_setting_and_super_guarantees_the_entry.sql"
"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-before.jsonl"
run_game_probe diamond-one-setting-super-guarantee 'NOTICE:  PASS One setting and Super guarantee: Diamond and Super tables, ten drops a game, twelve-street road, six mines, exact quotes before Start, old settings and other drop counts refused without a debit, Super Plinko batch and Crash, road and Mines losses pay the entry, ordinary floor kept, sealed history readable'

# Fairness: the sealed draws themselves reach the designed outcomes at the
# designed rate. Read only, fixed seeds, no money path: this is the check that
# the twenty Plinko games Dan played could not have found, because a table's
# 0.80 arithmetic being exact says nothing about how often 20x actually lands.
run_game_probe diamond-bonus-fairness-audit 'NOTICE:  PASS Diamond fairness audit (contract 3):'

# The installed ticket sweep (20260921185541) comes first: it is the earliest of
# the three migrations left, its expired-unused DELETE is the one the new ticket
# lock admits, and the contract-3 probes are re-run on top of it while contract
# 3 is still what is installed.
"${diamond_psql[@]}" -f "$diamond/crash-lock-dependencies.sql" \
  -f "$root/supabase/migrations/20260921185541_a_saved_round_settles_itself_and_a_ticket_is_never_pulled_from_under_a_live_page.sql"
"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-before.jsonl"
run_game_probe diamond-crash-clicked-multiplier 'NOTICE:  PASS Crash clicked multiplier: exact 2.57x, no late rescue, auto and cap preserved, future and foreign requests refused, one payout on replay'
run_game_probe diamond-one-setting-super-guarantee 'NOTICE:  PASS One setting and Super guarantee: Diamond and Super tables, ten drops a game, twelve-street road, six mines, exact quotes before Start, old settings and other drop counts refused without a debit, Super Plinko batch and Crash, road and Mines losses pay the entry, ordinary floor kept, sealed history readable'

# --- D2 bonus rules 2026-09-21 ---
# Owner rulings R3, R6, R10, R11 and R16 (Dan, 2026-09-21): the first step of a
# bonus game never ruins it, the floor is half the stake or what a Super player
# paid (add-on included), Plinko's drop value is the player's again and the
# add-on debit names itself. Qualified on the exact production preimages of every
# starter, actor, decider, quote and receipt the migration patches; then the
# fairness audit is re-run so the sealed draws are held to the contract-4 forms.
"${diamond_psql[@]}" -f "$root/supabase/migrations/20260921203512_the_first_step_of_a_bonus_game_never_ruins_it_and_the_floor_.sql"
"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-before.jsonl"
run_game_probe diamond-first-step-and-paid-floor 'NOTICE:  PASS First step and paid floor: floors exact for every stake 25..2500 on four stake kinds, crash never below 1.10x and every target 0.80B, street one certain and every street 0.80B, mines dealt around the first pick and fair, owner example 2500+2500 pays at least 50 on all four games, add-on debited once as itself with one custody movement and replay-safe, every payout journaled once from promo, ordinary half floor and 0.80x first steps, old round keeps 1.01x;'
run_game_probe diamond-bonus-fairness-audit 'NOTICE:  PASS Diamond fairness audit (contract 4):'
# --- end D2 bonus rules 2026-09-21 ---

# A live Crash round is sealed like every other round (fairness audit,
# 2026-09-22). The lock is the LAST of the three by version, so it lands on top
# of contract 4, and the probe that proves the games still play through it is
# the contract-4 one: diamond-one-setting-super-guarantee described contract 3's
# Diamond table and ten-drop rule, which 20260921203512 legitimately replaced,
# so re-running it here would be asserting a contract that is no longer
# installed rather than testing the lock.
"${diamond_psql[@]}" -f "$root/supabase/migrations/20260922173914_a_live_crash_round_is_sealed_like_every_other_round.sql"
"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-before.jsonl"
run_game_probe diamond-crash-clicked-multiplier 'NOTICE:  PASS Crash clicked multiplier: exact 2.57x, no late rescue, auto and cap preserved, future and foreign requests refused, one payout on replay'
run_game_probe diamond-first-step-and-paid-floor 'NOTICE:  PASS First step and paid floor: floors exact for every stake 25..2500 on four stake kinds, crash never below 1.10x and every target 0.80B, street one certain and every street 0.80B, mines dealt around the first pick and fair, owner example 2500+2500 pays at least 50 on all four games, add-on debited once as itself with one custody movement and replay-safe, every payout journaled once from promo, ordinary half floor and 0.80x first steps, old round keeps 1.01x;'
run_game_probe diamond-crash-round-is-sealed 'NOTICE:  PASS Crash round sealed: cash-out, instant crash and time settlement through the lock with nothing sealed moved, 36 rewrites refused (21 sealed columns, 2 settlement columns on a round still open, the minimum, a smuggled crash point, a settled edit, 2 deletes, 8 ticket re-spends, un-spends, rewrites and deletes), expired ticket swept, live tickets kept, maintenance escape unchanged'

# --- D3 settlement burn and quiet ledger 2026-09-21 --- (burn half, owner rulings R14, R16, R17)
# 1. The migration applies over a database that already holds a day settled
#    under the pre-burn contract and an older open day (production's shape on
#    2026-09-21): the settled day is untouched, the open day burns when it settles.
"${diamond_psql[@]}" -f "$diamond/daily-burn-dependencies.sql"
"${diamond_psql[@]}" -c 'CREATE DATABASE diamond_custody_legacy TEMPLATE diamond_games_probe OWNER postgres'
legacy_psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55487 -U postgres -d diamond_custody_legacy)
"${legacy_psql[@]}" -f "$diamond/daily-burn-legacy-seed.sql" > "$fixture/burn-legacy-seed.stdout"
"${legacy_psql[@]}" -f "$root/supabase/migrations/20260921202834_diamond_spins_daily_settlement_burns_twenty_percent_of_a_pro.sql"
"${legacy_psql[@]}" -f "$diamond/daily-burn-legacy-assert.sql" > "$fixture/burn-legacy.stdout" 2> "$fixture/burn-legacy.stderr"
cat "$fixture/burn-legacy.stdout" "$fixture/burn-legacy.stderr"
if [ "$(grep -Fc 'NOTICE:  PASS Daily burn installation:' "$fixture/burn-legacy.stderr")" -ne 1 ] || grep -Eq 'ERROR:|WARNING:|FATAL:|PANIC:' "$fixture/burn-legacy.stderr"; then
  echo 'The burn migration did not install cleanly over a pre-burn settled day' >&2
  exit 1
fi
# 2. The burn itself, the three statement lines, the addendum receipt, and the
#    R16 audit that every spin movement has its ledger row, all rolled back.
"${diamond_psql[@]}" -f "$root/supabase/migrations/20260921202834_diamond_spins_daily_settlement_burns_twenty_percent_of_a_pro.sql"
"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-before.jsonl"
run_game_probe diamond-spins-daily-profit-burn 'NOTICE:  PASS Daily profit burn: 210 net burns 42 and credits 168 in one transfer with one register burn row, negative, odd, tiny and zero days, exact rounding, supply and trial balance unchanged, replay writes nothing, burn failure rolls back, quiet statement notice with no push, three statement lines, base agreement keeps play open and the addendum receipt is separate'
run_game_probe diamond-spins-every-movement-has-a-ledger-row 'NOTICE:  PASS Every movement has a ledger row: exact entry journal and custody intake per spin, Promo-first then bank chip prizes journaled in chip_ledger, chip_transactions and union wallet rows, diamond prizes both sides, item grants as feature_purchases with retired custody, bonus as an award only, day equals movements, wallets equal journals, no documents'

# 3. The two-connection settlement race now runs on the burn contract (moved
#    here from the pre-burn state; its assert expects one transfer of 80, one
#    burn of 20 and no push).
# Observe a genuine two-connection duplicate race in a SECOND disposable local
# database. Its commits never touch production or the rollback-probe baseline.
"${diamond_psql[@]}" -c 'CREATE DATABASE diamond_custody_race TEMPLATE diamond_games_probe OWNER postgres'
race_psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55487 -U postgres -d diamond_custody_race)
"${race_psql[@]}" -f "$diamond/daily-custody-concurrency-seed.sql" > "$fixture/custody-race-seed.stdout"
"${race_psql[@]}" > "$fixture/custody-race-a.stdout" 2> "$fixture/custody-race-a.stderr" <<'SQL' &
BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL application_name='diamond-custody-race-a';
SET LOCAL "request.jwt.claims"='{"role":"service_role"}';
SELECT public.fn_diamond_spin_settle_day('d1000000-0000-4000-8000-000000000002',(clock_timestamp() AT TIME ZONE 'America/Chicago')::date-1);
SELECT pg_sleep(2);
COMMIT;
SQL
race_a=$!
# Wait for the first exact function invocation to own the row before its duplicate.
first_owned=0
for attempt in $(seq 1 60); do
  if [ "$("${race_psql[@]}" -Atc "SELECT count(*) FROM pg_stat_activity WHERE application_name='diamond-custody-race-a' AND wait_event='PgSleep'")" = 1 ]; then first_owned=1; break; fi
  sleep 0.02
done
if [ "$first_owned" != 1 ]; then wait "$race_a"; echo 'First settlement never reached its held receipt' >&2; exit 1; fi
"${race_psql[@]}" > "$fixture/custody-race-b.stdout" 2> "$fixture/custody-race-b.stderr" <<'SQL' &
BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL application_name='diamond-custody-race-b';
SET LOCAL "request.jwt.claims"='{"role":"service_role"}';
SELECT public.fn_diamond_spin_settle_day('d1000000-0000-4000-8000-000000000002',(clock_timestamp() AT TIME ZONE 'America/Chicago')::date-1);
COMMIT;
SQL
race_b=$!
blocked=0
for attempt in $(seq 1 60); do
  if [ "$("${race_psql[@]}" -Atc "SELECT count(*) FROM pg_stat_activity a,pg_stat_activity b WHERE a.application_name='diamond-custody-race-a' AND b.application_name='diamond-custody-race-b' AND a.pid=ANY(pg_blocking_pids(b.pid))")" = 1 ]; then blocked=1; break; fi
  sleep 0.02
done
wait "$race_a"
wait "$race_b"
cat "$fixture/custody-race-a.stderr" "$fixture/custody-race-b.stderr"
if [ "$blocked" != 1 ] || ! grep -Fq '"replayed": true' "$fixture/custody-race-b.stdout" ||
   grep -Eq 'ERROR:|WARNING:|FATAL:|PANIC:' "$fixture/custody-race-a.stderr" "$fixture/custody-race-b.stderr"; then
  echo 'The concurrent settlement did not block and replay its exact owner receipt' >&2
  exit 1
fi
"${race_psql[@]}" -f "$diamond/daily-custody-concurrency-assert.sql"

# --- D1 wheel v4 2026-09-21 ---
# Owner rulings R2, R12, R13, R15 and the server half of R18 (Dan, 2026-09-21):
# the wheel pays a game half the time, instant chips three tenths and an item a
# fifth; a VIP never wins an item; no prize or game ever repeats back to back;
# Diamonds deals three cards; and a run may leave the prizes it wins unplayed.
# Qualified last, on the exact installed preimages of the spin, the state and
# the profile guard, then the whole maths, four hundred real spins, the VIP
# wheel, the card game and the run. The R16 ledger audit is re-run afterwards so
# that its wheel-v4 branch (fn_wheel_diamond_cards_pick, paid exactly once) runs
# against the contract it was written for.
"${diamond_psql[@]}" -f "$root/supabase/migrations/20260922194123_diamond_wheel_v4_draws_a_different_prize_every_time_and_diam.sql"
"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-before.jsonl"
run_game_probe diamond-wheel-v4-model-and-matrix 'NOTICE:  PASS Wheel v4 model and matrix: twelve ords and 0.8 exactly for every entry 25..2500 standard and VIP, a VIP table with no items and the same 5000 on ords 3/6/9, a symmetric zero-diagonal matrix whose rows and columns both sum to the base law, the mix exactly 50/30/20, every conditional expectation at most 0.862037 of the entry, the cross-tier rule value neutral on both wheels and six distinct card orders each worth 11/6'
run_game_probe diamond-wheel-v4-draw-and-cards 'NOTICE:  PASS Wheel v4 draw and cards: 400 real spins with no repeated prize or game, the mix'
run_game_probe diamond-spins-every-movement-has-a-ledger-row 'NOTICE:  PASS Every movement has a ledger row: exact entry journal and custody intake per spin, Promo-first then bank chip prizes journaled in chip_ledger, chip_transactions and union wallet rows, diamond prizes both sides, item grants as feature_purchases with retired custody, bonus as an award only, day equals movements, wallets equal journals, no documents'
# --- end D1 wheel v4 2026-09-21 ---
