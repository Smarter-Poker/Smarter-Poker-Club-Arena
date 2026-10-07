// SOURCE CONTRACTS ONLY. No PostgreSQL execution or qualification is implied.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildCapturePayoutFixture,
  baselineFixture,
} from './leaderboard-capture-payout-fixture-candidate.mjs';
import { buildPromoPayoutCandidate, predecessor } from './leaderboard-promo-payout-candidate.mjs';

const capture = readFileSync(
  new URL('./leaderboard-capture-basis-candidate.sql', import.meta.url),
  'utf8'
);
const regression = readFileSync(
  new URL('./leaderboard-capture-basis-regression-candidate.sql', import.meta.url),
  'utf8'
);
const baseline = readFileSync(baselineFixture, 'utf8');
test('producer freezes first complete applied capture while preserving shared daily upserts', () => {
  assert.match(capture, /WITH applied AS MATERIALIZED/);
  assert.match(capture, /FROM public\.player_stats WHERE club_id IS NOT NULL/);
  assert.match(capture, /ON CONFLICT \(user_id, club_id, snapshot_date\) DO UPDATE/);
  assert.match(capture, /FROM applied HAVING v_new_capture/);
  assert.match(capture, /v_date <> \(v_capture_at AT TIME ZONE 'UTC'\)::date/);
  assert.ok(
    capture.indexOf('LEADERBOARD_CAPTURE_DATE_CONTRACT_MISMATCH') <
      capture.indexOf('WITH applied AS MATERIALIZED')
  );
  assert.match(capture, /CURRENT_DATE/);
  assert.doesNotMatch(capture, /cron\.schedule|hand_history|accepted_hand|DISABLE TRIGGER/);
});
test('closed canonical windows use exact complete boundaries and legitimate individual zero', () => {
  assert.match(capture, /p_end > \(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'\)::date/);
  assert.match(capture, /extract\(dow FROM p_start\) <> 0 OR p_end <> p_start \+ 7/);
  assert.match(capture, /extract\(day FROM p_start\) <> 1/);
  assert.match(capture, /WHERE capture_date = p_start/);
  assert.match(capture, /WHERE capture_date = p_end/);
  assert.match(capture, /v_count <> v_capture\.row_count/);
  assert.match(capture, /v_hash <> v_capture\.counter_hash/);
  assert.match(capture, /LEFT JOIN public\.leaderboard_capture_counters opening/);
  assert.match(capture, /closing\.hands_dealt - COALESCE\(opening\.hands_dealt, 0\)/);
  assert.match(
    capture,
    /COALESCE\(jsonb_agg\(to_jsonb\(d\) ORDER BY d\.user_id\), '\[\]'::jsonb\)/
  );
});
test('rollout preserves promised existing rounds without fabricating initial captures', () => {
  assert.match(capture, /weekly\.end_date, monthly\.end_date/);
  assert.match(capture, /SELECT id FROM public\.clubs/);
  assert.match(capture, /p_start < v_cutoff AND EXISTS/);
  assert.match(capture, /'basis_version', 'legacy_v1', 'complete', false/);
  assert.match(
    capture,
    /BEFORE INSERT OR UPDATE OR DELETE ON public\.leaderboard_basis_existing_clubs/
  );
  assert.doesNotMatch(capture, /PERFORM public\.fn_snapshot_player_stats\(\)/);
  assert.match(regression, /'existing_club_legacy_is_explicit'/);
  assert.match(regression, /'First capture date mismatch was not refused before all writes'/);
  assert.match(regression, /'Repeated actual producer replaced first complete capture'/);
  assert.match(regression, /INSERT INTO public\.clubs/);
  assert.match(regression, /is_union AND chip_treasury=0 AND promo_balance=0/);
  assert.match(regression, /session_user<>'leaderboard_qualification_bootstrap'/);
  assert.equal(regression.match(/^ROLLBACK;$/gm)?.length, 1);
  assert.doesNotMatch(regression, /^COMMIT;|DISABLE TRIGGER|WHERE false/m);
});
test('separate payout variant retains six actual financial cases and refuses stale or missing v2 capture', () => {
  const generated = buildCapturePayoutFixture(baseline);
  assert.match(generated, /candidate installed before synthetic clubs/);
  assert.match(generated, /rejection IS DISTINCT FROM 'LEADERBOARD_CAPTURE_UNAVAILABLE'/);
  assert.match(generated, /error_state IS DISTINCT FROM '55000'/);
  assert.match(generated, /GROUP BY snapshot_date/);
  assert.match(generated, /FROM public\.player_stats_snapshots;/);
  assert.match(generated, /r\.program_id=capture_cases\.program_id/);
  assert.match(generated, /r\.winners_hash=md5\(r\.winners::text\)/);
  assert.match(
    generated,
    /UPDATE public\.player_stats_snapshots SET total_winnings=total_winnings\+777/
  );
  assert.match(generated, /IS DISTINCT FROM before_digest THEN/);
  assert.match(generated, /fn_diamond_game_fund_promo/);
  assert.match(generated, /post_to_balance-pre_to_balance=expected_total/);
  assert.match(generated, /positive_awards_only_for_cent_tie/);
  assert.match(generated, /new_player_zero_baseline_pays/);
  assert.equal(generated.match(/^ROLLBACK;$/gm)?.length, 1);
  assert.doesNotMatch(generated, /^COMMIT;|DISABLE TRIGGER/m);
  assert.equal(readFileSync(baselineFixture, 'utf8'), baseline);
  for (const changed of [baseline + '\n', baseline.replace('DO $guard$', 'DO $changed$')])
    assert.throws(() => buildCapturePayoutFixture(changed));
});
test('all capture metadata and receipts refuse mutation including truncate, without settled-row cleanup', () => {
  for (const table of [
    'leaderboard_complete_captures',
    'leaderboard_capture_counters',
    'leaderboard_basis_rollout',
    'leaderboard_basis_existing_clubs',
    'leaderboard_round_basis_receipts',
  ]) {
    assert.ok(capture.includes(`BEFORE TRUNCATE ON public.${table}`));
    assert.ok(capture.includes(`DELETE ON public.${table}`));
  }
  assert.match(regression, /Captured counter mutation unexpectedly accepted/);
  assert.match(regression, /Constraint\/immutability test receipt only, NOT an actual payout/);
  assert.doesNotMatch(
    regression,
    /DELETE FROM public\.(?:leaderboard_payouts|leaderboard_payout_batches)|UPDATE public\.(?:club_members|union_wallets|club_opening_setups)/
  );
});
test('actual payout source proposal locks before replay and freezes positive final awards before funding', () => {
  const payout = buildPromoPayoutCandidate(readFileSync(predecessor, 'utf8'));
  assert.ok(payout.indexOf('pg_advisory_xact_lock') < payout.indexOf('SELECT batch.*'));
  assert.ok(
    payout.indexOf('fn_leaderboard_complete_round_basis') <
      payout.indexOf('INSERT INTO public.leaderboard_round_basis_receipts')
  );
  assert.ok(
    payout.indexOf('INSERT INTO public.leaderboard_round_basis_receipts') <
      payout.indexOf('FROM public.union_wallets wallet')
  );
  assert.match(payout, /WHERE winners\.amount > 0/);
  assert.match(payout, /v_winners, md5\(v_winners::text\)/);
  assert.match(payout, /'seed_funded', v_existing\.seed_funded/);
  assert.doesNotMatch(payout, /UPDATE public\.leaderboard_round_basis_receipts|ON CONFLICT/);
});
