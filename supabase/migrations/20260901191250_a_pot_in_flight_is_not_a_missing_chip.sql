-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901191250; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 2: THE TOURNAMENT CONSERVATION CHECK COULD NEVER READ CLEAN
--
-- fn_tournament_chip_conservation_check compares expected chips (buy-ins +
-- rebuys + add-ons) against SUM(table_seats.stack). The moment a player puts
-- chips into a pot, those chips leave `stack` and sit in the pot -- and the
-- database has no column for the pot. `tables.live_state` would carry it, but
-- it is NULL for the very tournaments the check flags (0 of 5 tables on the
-- Prime Time Main Event).
--
-- So the check measures a quantity that is only conserved at a hand boundary,
-- at an arbitrary moment mid-hand. Reading it live today: -29,910 chips on a
-- 45-player event, -9,992 on a 377-player freeroll. Those are pots, not
-- losses. A detector that fires on every running tournament teaches everyone
-- to ignore it, which is exactly what happened to its one incident.
--
-- THE FIX: confirm before alarming. A pot resolves in seconds; genuinely
-- missing chips do not. Sample the drift twice. Raise an incident only when
-- the SAME drift survives a second look AND hands have completed in between
-- (proving the table moved on and the chips did not come back). Everything
-- else is recorded and stays quiet.
--
-- This never blocks, pauses or freezes a tournament. It writes a sample row,
-- and sometimes an incident.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ca_tournament_conservation_samples (
  tournament_id uuid        NOT NULL,
  taken_at      timestamptz NOT NULL DEFAULT now(),
  drift         numeric     NOT NULL,
  hands_dealt   bigint      NOT NULL,
  players       bigint      NOT NULL,
  PRIMARY KEY (tournament_id, taken_at)
);

COMMENT ON TABLE public.ca_tournament_conservation_samples IS
  'Successive readings of tournament chip conservation. Two readings with the same drift, separated by completed hands, is the signature of chips that are actually gone rather than sitting in a pot the database cannot see.';

CREATE INDEX IF NOT EXISTS ix_ca_tourn_cons_recent
  ON public.ca_tournament_conservation_samples (tournament_id, taken_at DESC);

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_conservation_confirm()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row     record;
  v_prev    record;
  v_hands   bigint;
  v_raised  int := 0;
  v_sampled int := 0;
BEGIN
  FOR v_row IN SELECT * FROM public.fn_tournament_chip_conservation_check() LOOP
    SELECT COALESCE(sum(tb.hands_dealt), 0) INTO v_hands
      FROM public.tables tb WHERE tb.tournament_id = v_row.tournament_id;

    SELECT * INTO v_prev
      FROM public.ca_tournament_conservation_samples s
     WHERE s.tournament_id = v_row.tournament_id
     ORDER BY s.taken_at DESC LIMIT 1;

    INSERT INTO public.ca_tournament_conservation_samples
      (tournament_id, drift, hands_dealt, players)
    VALUES (v_row.tournament_id, v_row.drift, v_hands, v_row.players);
    v_sampled := v_sampled + 1;

    -- Confirmed only when the drift is unchanged AND the tournament dealt
    -- hands since the previous look. Identical drift across completed hands
    -- cannot be a pot: pots pay out.
    IF v_prev.tournament_id IS NOT NULL
       AND v_prev.drift = v_row.drift
       AND v_hands > v_prev.hands_dealt
    THEN
      PERFORM public.fn_ca_raise_drift_incident(
        p_source          => 'fn_ca_tournament_conservation_confirm',
        p_classification  => 'ledger_imbalance',
        p_severity        => 'critical',
        p_dedupe_key      => 'tourn-conservation:' || v_row.tournament_id::text
                             || ':' || v_row.drift::text,
        p_discrepancy     => v_row.drift,
        p_expected        => v_row.expected_chips,
        p_actual          => v_row.actual_chips,
        p_layer           => 'settlement',
        p_entity_type     => 'tournament',
        p_tournament_id   => v_row.tournament_id,
        p_suspected_cause => 'Tournament chip conservation drift of ' || v_row.drift::text
          || ' held steady across ' || (v_hands - v_prev.hands_dealt)::text
          || ' completed hands, so it is not chips sitting in a pot. Stacks do not '
          || 'add up to buy-ins plus rebuys plus add-ons on "' || v_row.name || '".',
        p_ledger_balanced => false,
        p_metadata        => jsonb_build_object(
          'tournament', v_row.name, 'players', v_row.players,
          'drift_per_player', v_row.drift_per_player,
          'hands_between_samples', v_hands - v_prev.hands_dealt,
          'first_seen_at', v_prev.taken_at));
      v_raised := v_raised + 1;
    END IF;
  END LOOP;

  DELETE FROM public.ca_tournament_conservation_samples
   WHERE taken_at < now() - interval '7 days';

  RETURN jsonb_build_object('checked_at', now(), 'sampled', v_sampled, 'confirmed', v_raised);
END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_tournament_conservation_confirm() IS
  'Every 10 minutes. Samples tournament chip conservation and raises an incident only for drift that survives a second reading with completed hands in between. Never blocks or pauses a tournament.';

REVOKE ALL ON FUNCTION public.fn_ca_tournament_conservation_confirm() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_conservation_confirm() TO service_role;

ALTER TABLE public.ca_tournament_conservation_samples ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_tournament_conservation_samples FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.ca_tournament_conservation_samples TO service_role;

