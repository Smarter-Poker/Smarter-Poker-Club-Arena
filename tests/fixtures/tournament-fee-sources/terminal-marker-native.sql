CREATE OR REPLACE FUNCTION public.fn_stamp_tournament_terminal_evidence_markers()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_terminal_at timestamptz;
BEGIN
  IF upper(COALESCE(NEW.status::text,'')) NOT IN
       ('COMPLETED','CANCELLED','CANCELED')
     OR (TG_OP = 'UPDATE' AND upper(COALESCE(OLD.status::text,'')) IN
       ('COMPLETED','CANCELLED','CANCELED')) THEN
    RETURN NEW;
  END IF;
  v_terminal_at := NEW.ended_at;
  IF v_terminal_at IS NULL OR NOT isfinite(v_terminal_at) THEN
    RAISE EXCEPTION 'terminal tournament % requires one finite close marker',NEW.id
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.tournament_players
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_obligations
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_payouts
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_rake_settlements
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.rake_records
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_bounty_chests
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_bounty_awards
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_guarantee_overlays
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.table_seats s
     SET terminal_closed_at = v_terminal_at
    FROM public.tables tb
   WHERE tb.id = s.table_id AND tb.tournament_id = NEW.id
     AND s.terminal_closed_at IS NULL;
  UPDATE public.wallet_transactions
     SET terminal_closed_at = v_terminal_at
   WHERE related_entity_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_bounty_award_recipients r
     SET terminal_closed_at = v_terminal_at
    FROM public.tournament_bounty_awards a
   WHERE a.id = r.award_id AND a.tournament_id = NEW.id
     AND r.terminal_closed_at IS NULL;
  UPDATE public.tournament_escrow
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  -- Contribution and jackpot-draw rows already have an unconditional
  -- append-only guard. Cancellation reversal/surplus rows intentionally do
  -- not, so give precisely those mutable Spin rows the terminal tuple marker.
  UPDATE public.spin_reserve_ledger
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id
     AND kind NOT IN ('contribution','jackpot_draw')
     AND terminal_closed_at IS NULL;

  IF EXISTS (SELECT 1 FROM public.tournament_players x
              WHERE x.tournament_id=NEW.id
                AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_payouts x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.rake_records x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_guarantee_overlays x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (
       SELECT 1 FROM public.table_seats s
       JOIN public.tables tb ON tb.id=s.table_id
        WHERE tb.tournament_id=NEW.id
          AND s.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.wallet_transactions x
                 WHERE x.related_entity_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_award_recipients r
       JOIN public.tournament_bounty_awards a ON a.id=r.award_id
        WHERE a.tournament_id=NEW.id
          AND r.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_escrow x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger x
                 WHERE x.tournament_id=NEW.id
                   AND x.kind NOT IN ('contribution','jackpot_draw')
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at) THEN
    RAISE EXCEPTION 'terminal tournament % did not stamp every mutable evidence row',
      NEW.id USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER stamp_tournament_terminal_evidence_markers AFTER INSERT OR UPDATE OF status ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_stamp_tournament_terminal_evidence_markers();
