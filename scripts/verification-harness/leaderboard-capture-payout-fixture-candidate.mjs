// UNQUALIFIED source adapter. Never connects, installs, or executes SQL.
// Future owning runner: install capture+payout candidates on EMPTY restored DB,
// THEN execute existing authorization and this fixture in one rollback socket.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const baselineFixture = new URL(
  './leaderboard-isolated-payout-regression-draft.sql',
  import.meta.url
);
export function buildCapturePayoutFixture(source = readFileSync(baselineFixture, 'utf8')) {
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    'c9de63e5dad19460da2df2aead2c1c072acf8ef0ae6f8b801e198c683eae01fc'
  );
  function replaceOnce(before, after) {
    assert.equal(source.split(before).length, 2, 'Reviewed payout fixture anchor changed');
    source = source.replace(before, () => after);
  }
  replaceOnce('DO $cases$\nDECLARE', 'DO $cases$\n<<capture_cases>>\nDECLARE');
  replaceOnce(
    'DO $guard$\nBEGIN',
    `DO $guard$
BEGIN
  IF to_regclass('public.leaderboard_complete_captures') IS NULL
     OR to_regclass('public.leaderboard_round_basis_receipts') IS NULL
     OR EXISTS(SELECT 1 FROM public.leaderboard_basis_existing_clubs)
     OR EXISTS(SELECT 1 FROM public.leaderboard_complete_captures)
     OR EXISTS(SELECT 1 FROM public.leaderboard_round_basis_receipts) THEN
    RAISE EXCEPTION 'Capture payout fixture requires candidate installed before synthetic clubs and empty captures';
  END IF;`
  );
  replaceOnce(
    "      IF case_name='new_player_zero_baseline_pays' AND (",
    `      -- Explicit HISTORICAL SYNTHETIC captures, not producer/calendar proof.
      -- Every case is a rollback subtransaction, so no immutable history is
      -- deleted or rewritten to reuse its dates. Complete domain is derived
      -- independently from exact synthetic counters, including empty opening.
      INSERT INTO public.leaderboard_complete_captures
        (capture_date,captured_at,capture_timezone,origin,source_contract,row_count,counter_hash,complete)
      SELECT snapshot_date,(snapshot_date+time '00:05') AT TIME ZONE 'UTC',
        'UTC','fn_snapshot_player_stats','applied_player_stats_v1',count(*),
        md5(string_agg((to_jsonb(c)-'snapshot_date')::text,E'\\n' ORDER BY club_id,user_id)),true
      FROM (SELECT snapshot_date,user_id,club_id,hands_played,hands_dealt,sum_big_blind,
        total_winnings,total_losses,total_rake,tournaments_played,tournaments_won
        FROM public.player_stats_snapshots) c GROUP BY snapshot_date;
      INSERT INTO public.leaderboard_capture_counters
        (snapshot_date,user_id,club_id,hands_played,hands_dealt,sum_big_blind,
         total_winnings,total_losses,total_rake,tournaments_played,tournaments_won)
      SELECT snapshot_date,user_id,club_id,hands_played,hands_dealt,sum_big_blind,
        total_winnings,total_losses,total_rake,tournaments_played,tournaments_won
      FROM public.player_stats_snapshots;
      IF case_name='new_player_zero_baseline_pays' AND (`
  );
  replaceOnce(
    "rejection NOT LIKE 'LEADERBOARD_SNAPSHOT_UNAVAILABLE|%'",
    "rejection IS DISTINCT FROM 'LEADERBOARD_CAPTURE_UNAVAILABLE'"
  );
  replaceOnce(
    'rejected := true; GET STACKED DIAGNOSTICS rejection=MESSAGE_TEXT;',
    'rejected := true; GET STACKED DIAGNOSTICS rejection=MESSAGE_TEXT,error_state=RETURNED_SQLSTATE;'
  );
  replaceOnce(
    "IF NOT rejected OR rejection IS DISTINCT FROM 'LEADERBOARD_CAPTURE_UNAVAILABLE' THEN",
    "IF NOT rejected OR error_state IS DISTINCT FROM '55000' OR rejection IS DISTINCT FROM 'LEADERBOARD_CAPTURE_UNAVAILABLE' THEN"
  );
  replaceOnce(
    'IF pg_temp.lb_financial_digest() IS DISTINCT FROM before_digest THEN',
    'IF pg_temp.lb_financial_digest() IS DISTINCT FROM before_digest OR EXISTS(SELECT 1 FROM public.leaderboard_round_basis_receipts) THEN'
  );
  replaceOnce(
    '        after_digest := pg_temp.lb_financial_digest();',
    `        IF (SELECT count(*) FROM public.leaderboard_round_basis_receipts)<>1
           OR NOT EXISTS(SELECT 1 FROM public.leaderboard_round_basis_receipts r
             WHERE r.club_id=club AND r.period='weekly' AND r.period_start=starts AND r.period_end=ends
               AND r.program_id=capture_cases.program_id AND r.program_version=version_number AND r.program_hash=md5(terms::text)
               AND r.basis_version='complete_capture_v2' AND r.basis->'complete'='true'::jsonb
               AND r.basis_hash=md5(r.basis::text)
               AND r.selected_board_hash=md5(r.selected_board::text)
               AND r.winners_hash=md5(r.winners::text)
               AND (SELECT COALESCE(sum((w->>'amount')::numeric),0) FROM jsonb_array_elements(r.winners) w)=expected_total
               AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.winners) w WHERE (w->>'amount')::numeric<=0)) THEN
          RAISE EXCEPTION 'Frozen complete basis receipt disagrees with independently reconciled award';
        END IF;
        before_digest := (SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY club_id,period,period_start)::text)
          FROM public.leaderboard_round_basis_receipts r);
        -- Change ONLY mutable synthetic legacy reporting inputs. Neither the
        -- complete counters nor the persisted payout/basis receipt may change.
        UPDATE public.player_stats_snapshots SET total_winnings=total_winnings+777
          WHERE club_id=club AND snapshot_date=ends;
        after_digest := pg_temp.lb_financial_digest();`
  );
  replaceOnce(
    '           OR pg_temp.lb_financial_digest() IS DISTINCT FROM after_digest THEN',
    `           OR pg_temp.lb_financial_digest() IS DISTINCT FROM after_digest
           OR (SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY club_id,period,period_start)::text)
               FROM public.leaderboard_round_basis_receipts r) IS DISTINCT FROM before_digest THEN`
  );
  assert.ok(source.endsWith('ROLLBACK;\n'));
  assert.equal(source.match(/^ROLLBACK;$/gm)?.length, 1);
  assert.doesNotMatch(source, /^COMMIT;/m);
  return '-- UNQUALIFIED complete-capture variant. Original baseline remains unchanged.\n' + source;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 2);
    process.stdout.write(buildCapturePayoutFixture());
  } catch {
    console.error('Capture payout fixture preparation refused; no runtime qualification');
    process.exitCode = 1;
  }
}
