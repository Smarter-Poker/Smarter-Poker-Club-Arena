-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828022245; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
-- spin_reap_stale_registering_boards
--
-- THE DEFECT
-- ----------
-- A Spin board opens in REGISTERING and waits for three seats. The moment a
-- player takes a seat their buy-in is debited for real -- a
-- wallet_transactions row, type='debit', category='tournament_buyin'. If the
-- third seat never arrives, nothing in the system ever gives up. The board
-- sits there. The money sits there. The player's chips are gone from their
-- wallet and they have no game.
--
-- MEASURED AT AUDIT TIME
-- ----------------------
-- 32 Spins in REGISTERING; 16 stale past 10 minutes, 7 past an hour, oldest
-- 1h14m. Eight boards had zero seats an hour after creation.
--
-- MEASURED AGAIN WHEN THIS MIGRATION WAS WRITTEN, 2026-08-28 ~02:30 UTC
-- --------------------------------------------------------------------
-- It has got worse, not better:
--   * 20 partially-sold boards past 15 minutes, holding 33 real seats and
--     727.00 chips of committed buy-ins. Oldest 2h34m.
--   * 9 boards with zero seats, oldest 1h55m.
-- Every one of those 33 seats is a player whose wallet is down and who has
-- nothing to show for it.
--
-- There is a one-shot "DO $$ ... $$" unstick block in the migration history.
-- That is a broom, not a mechanism: it cleaned the floor once and cannot fire
-- again. This migration is the mechanism.
--
-- WHY THIS FUNCTION DOES NOT MOVE ANY MONEY ITSELF
-- -----------------------------------------------
-- Tearing a board down means refunding committed buy-ins, and a refund is a
-- money write. This function deliberately does not know how to write money.
-- Instead it DELEGATES every teardown to public.atomic_cancel_tournament(),
-- which is the existing, already-tested cancel path used by club admins:
-- it takes the tournament row FOR UPDATE, flips it to CANCELLED, works out
-- what each player actually paid (buy-in + rebuy + addon, less refunds
-- already issued), credits it back through public.fn_credit_and_log() with a
-- per-player idempotency key, reverses the tournament fee in rake_records,
-- eliminates the seats and closes the tables. Reusing it means the refund
-- arithmetic and the idempotency live in exactly one place. If that path is
-- ever wrong, it is wrong once and gets fixed once.
--
-- One thing worth knowing about that delegation: atomic_cancel_tournament
-- checks club-admin rights, but only when auth.uid() is non-null. Called
-- from pg_cron or the service role there is no JWT, auth.uid() is null, and
-- the check is skipped by design. Called by a logged-in non-admin it will
-- raise, and this function catches that per board rather than aborting the
-- whole sweep.
--
-- DRY RUN IS THE DEFAULT, ON PURPOSE
-- ----------------------------------
-- p_dry_run defaults to TRUE, so as shipped this function is inert: it
-- reports what it would cancel and refunds nothing. Nobody's money moves
-- until a human passes p_dry_run => false, and no cron job is scheduled for
-- it in this migration. Flipping that default, or scheduling it, is a
-- deliberate human act and should be.
--
-- SCOPE OF WHAT IT WILL TOUCH
-- ---------------------------
-- Only tournaments with variant='spin', status='REGISTERING', started_at IS
-- NULL, older than p_stale_mins, and with fewer seats than max_players. A
-- board that has started is never touched. The status and seat count are
-- re-checked inside the loop immediately before cancelling, so a board that
-- fills and launches between the scan and the teardown is skipped rather
-- than killed mid-launch.
--
-- p_include_unsold covers the zero-seat boards. They hold no money, so
-- cancelling them refunds nothing; it just stops dead lobbies accumulating.
-- Note that the lobby generator recreates boards on demand -- a fresh
-- "100 Chip Spin NLH" appeared 39 seconds before this was written -- so
-- reaping empty ones is churn, not destruction. Set it false if you would
-- rather leave them alone.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_spin_reap_stale_boards(
  p_stale_mins     integer DEFAULT 15,
  p_dry_run        boolean DEFAULT true,
  p_include_unsold boolean DEFAULT true,
  p_limit          integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_mins      integer := GREATEST(COALESCE(p_stale_mins, 15), 1);
  v_limit     integer := GREATEST(COALESCE(p_limit, 100), 1);
  v_dry       boolean := COALESCE(p_dry_run, true);
  v_b         record;
  v_plan      jsonb := '[]'::jsonb;
  v_res       jsonb;
  v_partial   integer := 0;
  v_unsold    integer := 0;
  v_chips     numeric := 0;
  v_seats     integer := 0;
  v_cancelled integer := 0;
  v_refunded  numeric := 0;
  v_failed    integer := 0;
  v_skipped   integer := 0;
  v_still     text;
  v_now_seats integer;
BEGIN
  -- Two copies of this sweep racing each other would double-cancel. Don't.
  IF NOT pg_try_advisory_lock(hashtext('fn_spin_reap_stale_boards')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another reap is already running');
  END IF;

  FOR v_b IN
    SELECT t.id, t.name, t.club_id, t.buy_in_amount,
           COALESCE(t.max_players, 3) AS max_players,
           t.created_at,
           (SELECT COUNT(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id) AS seats,
           (SELECT COALESCE(SUM(
                     CASE WHEN w.type = 'debit'
                           AND w.category IN ('tournament_buyin','rebuy','addon') THEN w.amount
                          WHEN w.type = 'credit' AND w.category = 'refund'        THEN -w.amount
                          ELSE 0 END), 0)
              FROM public.wallet_transactions w
             WHERE w.related_entity_id = t.id) AS committed_chips
      FROM public.tournaments t
     WHERE t.variant   = 'spin'
       AND t.status    = 'REGISTERING'
       AND t.started_at IS NULL
       AND t.created_at < now() - make_interval(mins => v_mins)
     ORDER BY t.created_at
     LIMIT v_limit
  LOOP
    CONTINUE WHEN v_b.seats >= v_b.max_players;                       -- full: about to launch
    CONTINUE WHEN v_b.seats = 0 AND NOT COALESCE(p_include_unsold, true);

    IF v_b.seats = 0 THEN v_unsold := v_unsold + 1;
                     ELSE v_partial := v_partial + 1; END IF;
    v_seats := v_seats + v_b.seats;
    v_chips := v_chips + v_b.committed_chips;

    v_plan := v_plan || jsonb_build_object(
                'tournament_id',    v_b.id,
                'name',             v_b.name,
                'club_id',          v_b.club_id,
                'buy_in',           v_b.buy_in_amount,
                'seats_sold',       v_b.seats,
                'seats_needed',     v_b.max_players,
                'committed_chips',  v_b.committed_chips,
                'age_mins',         round(extract(epoch FROM (now() - v_b.created_at)) / 60),
                'action',           CASE WHEN v_dry THEN 'would delegate to atomic_cancel_tournament'
                                         ELSE 'delegated to atomic_cancel_tournament' END);

    CONTINUE WHEN v_dry;

    -- Re-check under the cancel path's own lock window. A board that filled
    -- and launched since the scan must be left alone.
    SELECT t.status,
           (SELECT COUNT(*) FROM public.tournament_players tp WHERE tp.tournament_id = t.id)
      INTO v_still, v_now_seats
      FROM public.tournaments t
     WHERE t.id = v_b.id
       FOR UPDATE;

    IF v_still IS DISTINCT FROM 'REGISTERING' OR v_now_seats >= v_b.max_players THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    BEGIN
      -- The ONLY teardown path. This function never writes a wallet,
      -- tournament_players or balance row itself.
      v_res := public.atomic_cancel_tournament(v_b.id, NULL);
      IF COALESCE((v_res->>'success')::boolean, false) THEN
        v_cancelled := v_cancelled + 1;
        v_refunded  := v_refunded + COALESCE((v_res->>'total_refunded')::numeric, 0);
      ELSE
        v_failed := v_failed + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES ('warning', 'fn_spin_reap_stale_boards',
              format('Could not tear down stale Spin board %s: %s',
                     COALESCE(v_b.name, v_b.id::text), SQLERRM),
              jsonb_build_object('tournament_id', v_b.id, 'club_id', v_b.club_id,
                                 'seats_sold', v_b.seats,
                                 'committed_chips', v_b.committed_chips,
                                 'sqlerrm', SQLERRM));
    END;
  END LOOP;

  PERFORM pg_advisory_unlock(hashtext('fn_spin_reap_stale_boards'));

  RETURN jsonb_build_object(
    'ok',                    true,
    'dry_run',               v_dry,
    'stale_mins',            v_mins,
    'include_unsold',        COALESCE(p_include_unsold, true),
    'candidates',            v_partial + v_unsold,
    'partially_sold_boards', v_partial,
    'unsold_boards',         v_unsold,
    'seats_affected',        v_seats,
    'committed_chips',       round(v_chips, 2),
    'cancelled',             v_cancelled,
    'chips_refunded',        round(v_refunded, 2),
    'skipped_raced',         v_skipped,
    'failed',                v_failed,
    'delegate',              'public.atomic_cancel_tournament(uuid, uuid)',
    'plan',                  v_plan);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_advisory_unlock(hashtext('fn_spin_reap_stale_boards'));
  RAISE;
END;
$fn$;

COMMENT ON FUNCTION public.fn_spin_reap_stale_boards(integer, boolean, boolean, integer) IS
  'Recurring reaper for Spin boards stuck in REGISTERING with committed '
  'buy-ins. Delegates every teardown and refund to atomic_cancel_tournament; '
  'writes no money itself. p_dry_run defaults TRUE so it is inert until a '
  'human flips it. No cron job is scheduled for it on purpose.';

REVOKE ALL ON FUNCTION public.fn_spin_reap_stale_boards(integer, boolean, boolean, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_spin_reap_stale_boards(integer, boolean, boolean, integer) TO service_role;

