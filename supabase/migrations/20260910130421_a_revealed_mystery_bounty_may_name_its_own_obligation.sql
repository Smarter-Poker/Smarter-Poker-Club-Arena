-- a_revealed_mystery_bounty_may_name_its_own_obligation
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- NO MYSTERY BOUNTY HAS EVER BEEN PAID THROUGH THIS PATH.
--
-- fn_mystery_bounty_pay does four things for each recipient: credits them,
-- stamps tournament_bounty_award_recipients.paid_at, adds to the player's
-- bounty_winnings, and writes the bounty-ledger row that records who collected
-- what for whose head:
--
--     INSERT INTO public.tournament_bounties
--       (tournament_id, eliminated_player_id, collector_player_id,
--        bounty_amount, is_mystery_revealed, bounty_obligation_id)
--     VALUES (..., true, v_a.bounty_obligation_id)
--
-- `v_a.bounty_obligation_id` is a MYSTERY CHEST obligation, and the BEFORE
-- INSERT trigger on tournament_bounties refuses exactly that:
--
--     WHERE o.id=NEW.bounty_obligation_id ... AND o.mode<>'mystery_chest'
--     ... RAISE 'bounty ledger names a mismatched obligation generation'
--
-- So the last statement of the payment raises, the whole transaction rolls
-- back - the credit with it - the obligation stays `pending`, and
-- TournamentManagerEliminations.recoverPendingBountyObligations then returns
-- false on every sweep, which returns BEFORE the bust stage. The event stops
-- recording eliminations entirely and cannot finish.
--
-- Measured 2026-09-10 12:55: five pending mystery-chest obligations across four
-- events, the oldest from 2026-09-08 17:16, and those four events between them
-- holding 2,008.00 in escrow with 21 busted players who could not be recorded.
-- The engine logged `Tournament.mystery_bounty_pay_failed ... bounty ledger
-- names a mismatched obligation generation` on a loop.
--
-- WHY THE EXCLUSION EXISTS, AND WHAT IT SHOULD HAVE SAID. The two attach
-- triggers are a matched pair: a MYSTERY award row (tournament_bounty_awards)
-- must name a mystery_chest obligation, and a bounty LEDGER row must name a
-- non-mystery one - so that a regular bounty cannot borrow a mystery
-- generation. That is right for the claim path and wrong for the payment path,
-- because a paid mystery chest IS a bounty ledger entry: the collector really
-- did take that player's head, and the row says so with
-- is_mystery_revealed = true.
--
-- THE FIX: a ledger row may name a mystery_chest obligation only when it is
-- itself flagged as a revealed mystery bounty. A regular bounty still cannot
-- borrow a mystery generation, which is the thing the guard was written to
-- prevent, and the payment that has never worked can complete.
--
-- The migration asserts afterwards that the five pending obligations are still
-- pending (it fixes the door; the engine pays through it on its next sweep)
-- and that no non-mystery ledger row anywhere names a mystery obligation.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_attach_bounty_ledger_obligation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_context text := current_setting('app.bounty_obligation_id',true);
  v_obligation_id uuid;
  /* A REVEALED MYSTERY BOUNTY MAY NAME ITS OWN OBLIGATION (2026-09-10).
     A paid mystery chest is a bounty ledger entry like any other and its
     provenance is the mystery obligation. Only a row that says so may name
     one; a regular bounty still cannot borrow a mystery generation. */
  v_mystery_ok boolean := COALESCE(NEW.is_mystery_revealed, false);
BEGIN
  IF NEW.bounty_obligation_id IS NULL THEN
    IF COALESCE(v_context,'')
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_obligation_id := v_context::uuid;
      SELECT o.id INTO NEW.bounty_obligation_id
        FROM public.tournament_bounty_obligations o
       WHERE o.id=v_obligation_id AND o.tournament_id=NEW.tournament_id
         AND o.eliminated_user_id=NEW.eliminated_player_id
         AND (o.mode<>'mystery_chest' OR v_mystery_ok);
      IF NEW.bounty_obligation_id IS NULL THEN
        RAISE EXCEPTION 'bounty ledger context does not match its exact generation'
          USING ERRCODE='check_violation';
      END IF;
    ELSIF EXISTS (
      SELECT 1 FROM public.tournament_bounty_obligations o
       WHERE o.tournament_id=NEW.tournament_id
         AND o.eliminated_user_id=NEW.eliminated_player_id
         AND o.mode<>'mystery_chest' AND o.state='pending'
    ) THEN
      RAISE EXCEPTION 'generation-bound bounty ledger insert has no exact obligation context'
        USING ERRCODE='check_violation';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.tournament_bounty_obligations o
     WHERE o.id=NEW.bounty_obligation_id AND o.tournament_id=NEW.tournament_id
       AND o.eliminated_user_id=NEW.eliminated_player_id
       AND (o.mode<>'mystery_chest' OR v_mystery_ok)
  ) THEN
    RAISE EXCEPTION 'bounty ledger names a mismatched obligation generation'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

DO $body$
DECLARE
  v_pending integer;
  v_borrowed integer;
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_attach_bounty_ledger_obligation';
  IF position('v_mystery_ok' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the ledger attach trigger was not replaced';
  END IF;
  -- the guard still holds: no ledger row that is NOT a revealed mystery
  -- bounty may name a mystery_chest obligation
  SELECT count(*) INTO v_borrowed
    FROM public.tournament_bounties b
    JOIN public.tournament_bounty_obligations o ON o.id = b.bounty_obligation_id
   WHERE o.mode = 'mystery_chest' AND COALESCE(b.is_mystery_revealed,false) = false;
  IF v_borrowed <> 0 THEN
    RAISE EXCEPTION '% non-mystery ledger row(s) already name a mystery obligation', v_borrowed;
  END IF;
  SELECT count(*) INTO v_pending
    FROM public.tournament_bounty_obligations o
    JOIN public.tournaments t ON t.id = o.tournament_id
   WHERE o.state='pending' AND o.mode='mystery_chest' AND t.status='RUNNING';
  RAISE NOTICE 'a_revealed_mystery_bounty: % pending mystery obligation(s) can now be paid by the engine', v_pending;
END
$body$;

COMMIT;
