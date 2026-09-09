-- 20260909183628_terminal_tournaments_cannot_reenter_a_break
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-09 18:36:28 UTC.
--
-- A completed $100 Freeroll was measured with ended_at 17:18:59 but a fresh
-- break_started_at 17:55:05 and on_break=true.  The atomic completion did
-- clear its break state.  A stale in-memory manager then accepted the hourly
-- break because its application write matched only tournament id; no database
-- invariant prevented a terminal row from re-entering a break afterwards.
--
-- This migration makes the terminal shape canonical at the data boundary.
-- The BEFORE trigger clears break state on the legitimate RUNNING/COMPLETING
-- -> COMPLETED or -> CANCELLED transition, refuses any later attempt to put a
-- terminal row back on break, and a CHECK constraint independently proves the
-- stored invariant.  Existing terminal clock residue is captured in a private,
-- immutable receipt before it is cleared.  Measured immediately before this
-- migration: one COMPLETED and one CANCELLED row were actively on break, while
-- 1,305 additional COMPLETED rows retained a stale break start timestamp.

BEGIN;

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

/* Supabase Realtime acquires its catalog relation before inspecting public
   relations. Take the same global boundary first, then exclude every writer
   from tournaments before the receipt snapshot. Without the second lock, a
   stale manager could stamp a new dirty terminal row between INSERT ... SELECT
   and UPDATE and that preimage would be cleared without a receipt. */
LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournaments IN SHARE ROW EXCLUSIVE MODE NOWAIT;

CREATE TABLE IF NOT EXISTS public.tournament_terminal_break_normalization_receipts (
  tournament_id uuid PRIMARY KEY,
  terminal_status text NOT NULL CHECK (upper(terminal_status) IN ('COMPLETED','CANCELLED')),
  on_break_before boolean NOT NULL,
  break_started_at_before timestamptz,
  break_ends_at_before timestamptz,
  normalization_version text NOT NULL
    CHECK (normalization_version = '20260909183628_terminal_tournaments_cannot_reenter_a_break'),
  normalized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    on_break_before
    OR break_started_at_before IS NOT NULL
    OR break_ends_at_before IS NOT NULL
  )
);

ALTER TABLE public.tournament_terminal_break_normalization_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_terminal_break_normalization_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_terminal_break_normalization_receipts
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.tournament_terminal_break_normalization_receipts IS
  'Private immutable preimage of terminal tournament break state normalized once by the 20260909183628 integrity boundary. No runtime writer exists.';

CREATE OR REPLACE FUNCTION public.fn_tournament_terminal_break_normalization_receipt_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'terminal tournament break normalization receipts are immutable'
    USING ERRCODE='check_violation';
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_terminal_break_normalization_receipt_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS tournament_terminal_break_normalization_receipt_immutable
  ON public.tournament_terminal_break_normalization_receipts;
CREATE TRIGGER tournament_terminal_break_normalization_receipt_immutable
BEFORE UPDATE OR DELETE ON public.tournament_terminal_break_normalization_receipts
FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_terminal_break_normalization_receipt_immutable();

INSERT INTO public.tournament_terminal_break_normalization_receipts(
  tournament_id,
  terminal_status,
  on_break_before,
  break_started_at_before,
  break_ends_at_before,
  normalization_version
)
SELECT
  t.id,
  upper(t.status::text),
  COALESCE(t.on_break,false),
  t.break_started_at,
  t.break_ends_at,
  '20260909183628_terminal_tournaments_cannot_reenter_a_break'
FROM public.tournaments t
WHERE upper(t.status::text) IN ('COMPLETED','CANCELLED')
  AND (
    COALESCE(t.on_break,false)
    OR t.break_started_at IS NOT NULL
    OR t.break_ends_at IS NOT NULL
  )
ON CONFLICT (tournament_id) DO NOTHING;

UPDATE public.tournaments t
   SET on_break=false,
       break_started_at=NULL,
       break_ends_at=NULL,
       updated_at=clock_timestamp()
 WHERE upper(t.status::text) IN ('COMPLETED','CANCELLED')
   AND (
     COALESCE(t.on_break,false)
     OR t.break_started_at IS NOT NULL
     OR t.break_ends_at IS NOT NULL
   );

CREATE OR REPLACE FUNCTION public.fn_guard_terminal_tournament_break_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  IF upper(NEW.status::text) NOT IN ('COMPLETED','CANCELLED') THEN
    RETURN NEW;
  END IF;

  /* A terminal transition owns the canonical clear even when an older caller
     omitted one of the three columns.  Once terminal, however, a later writer
     receives a hard refusal instead of silently manufacturing a live break. */
  IF TG_OP='UPDATE'
     AND upper(OLD.status::text) IN ('COMPLETED','CANCELLED')
     AND (
       COALESCE(NEW.on_break,false)
       OR NEW.break_started_at IS NOT NULL
       OR NEW.break_ends_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'terminal tournament % cannot re-enter a break',NEW.id
      USING ERRCODE='check_violation';
  END IF;

  NEW.on_break := false;
  NEW.break_started_at := NULL;
  NEW.break_ends_at := NULL;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_guard_terminal_tournament_break_state()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS aaa_guard_terminal_tournament_break_state
  ON public.tournaments;
CREATE TRIGGER aaa_guard_terminal_tournament_break_state
BEFORE INSERT OR UPDATE OF status,on_break,break_started_at,break_ends_at
ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_terminal_tournament_break_state();

ALTER TABLE public.tournaments
  DROP CONSTRAINT IF EXISTS tournaments_terminal_break_state_is_clear;
ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_terminal_break_state_is_clear
  CHECK (
    upper(status::text) NOT IN ('COMPLETED','CANCELLED')
    OR (
      on_break IS FALSE
      AND break_started_at IS NULL
      AND break_ends_at IS NULL
    )
  );

/* A BEFORE trigger that queries its own relation sees the stored OLD row, not
   the candidate NEW tuple modified by an earlier BEFORE trigger. The ordinary
   two-argument readiness contract must continue to flag every stored
   COMPLETING/on_break row, so do not weaken it globally. This private adapter
   removes only that one visibility artifact, and only for the exact terminal
   candidate passed by the completion trigger after the earlier terminal guard
   has canonicalized all three NEW break columns. Every unrelated readiness
   failure is retained in its original order. */
CREATE OR REPLACE FUNCTION smarter_private.fn_tournament_finish_readiness_for_terminal_candidate(
  p_tournament_id uuid,
  p_winner_user_id uuid,
  p_previous_status text,
  p_candidate_on_break boolean,
  p_candidate_break_started_at timestamptz,
  p_candidate_break_ends_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_ready jsonb;
  v_failures jsonb;
  v_stored_status text;
  v_stored_on_break boolean;
  v_terminal_break_failures integer;
BEGIN
  v_ready := public.fn_tournament_finish_readiness(
    p_tournament_id,
    p_winner_user_id
  );

  /* These arguments come from the trigger's real OLD and already-canonical
     NEW records. The stored-row proof prevents this adapter from becoming a
     general-purpose way to forgive terminal break residue. */
  IF upper(COALESCE(p_previous_status,'')) <> 'COMPLETING'
     OR p_candidate_on_break IS DISTINCT FROM false
     OR p_candidate_break_started_at IS NOT NULL
     OR p_candidate_break_ends_at IS NOT NULL
     OR jsonb_typeof(v_ready) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_ready->'failures') IS DISTINCT FROM 'array' THEN
    RETURN v_ready;
  END IF;

  SELECT upper(t.status::text),COALESCE(t.on_break,false)
    INTO v_stored_status,v_stored_on_break
    FROM public.tournaments t
   WHERE t.id=p_tournament_id;
  IF NOT FOUND
     OR v_stored_status IS DISTINCT FROM 'COMPLETING'
     OR v_stored_on_break IS DISTINCT FROM true THEN
    RETURN v_ready;
  END IF;

  SELECT count(*)::integer
    INTO v_terminal_break_failures
    FROM jsonb_array_elements(v_ready->'failures') AS failure(value)
   WHERE failure.value->>'code'='terminal_break_flag_set';
  IF v_terminal_break_failures <> 1 THEN
    RETURN v_ready;
  END IF;

  SELECT COALESCE(jsonb_agg(failure.value ORDER BY failure.ordinality),'[]'::jsonb)
    INTO v_failures
    FROM jsonb_array_elements(v_ready->'failures')
         WITH ORDINALITY AS failure(value,ordinality)
   WHERE failure.value->>'code'<>'terminal_break_flag_set';

  v_ready := jsonb_set(v_ready,'{failures}',v_failures,true);
  v_ready := jsonb_set(
    v_ready,
    '{ok}',
    to_jsonb(jsonb_array_length(v_failures)=0),
    true
  );
  v_ready := jsonb_set(
    v_ready,
    '{reason}',
    CASE WHEN jsonb_array_length(v_failures)=0
         THEN 'null'::jsonb
         ELSE to_jsonb(v_failures->0->>'code') END,
    true
  );
  RETURN v_ready;
END;
$function$;

REVOKE ALL ON FUNCTION
  smarter_private.fn_tournament_finish_readiness_for_terminal_candidate(
    uuid,uuid,text,boolean,timestamptz,timestamptz
  ) FROM PUBLIC, anon, authenticated, service_role;

/* Patch only the completion trigger's call site, with an asserted unique
   substitution. The already-applied readiness function and all of its direct
   callers retain their original two-argument semantics. */
DO $make_finish_certificate_candidate_aware$
DECLARE
  v_definition text;
  v_next text;
  v_old constant text := $old$  v_ready := public.fn_tournament_finish_readiness(NEW.id,v_winner);$old$;
  v_new constant text := $new$  v_ready := smarter_private.fn_tournament_finish_readiness_for_terminal_candidate(
    NEW.id,
    v_winner,
    OLD.status::text,
    NEW.on_break,
    NEW.break_started_at,
    NEW.break_ends_at
  );$new$;
BEGIN
  IF to_regprocedure('public.fn_tournament_finish_readiness(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_guard_tournament_completed_certificate()') IS NULL THEN
    RAISE EXCEPTION
      'terminal break invariant requires finish readiness and its completion guard';
  END IF;

  SELECT pg_get_functiondef(
           'public.fn_guard_tournament_completed_certificate()'::regprocedure
         )
    INTO STRICT v_definition;

  IF position(v_old IN v_definition) > 0 THEN
    IF length(v_definition) - length(replace(v_definition,v_old,''))
         <> length(v_old) THEN
      RAISE EXCEPTION 'finish-certificate readiness call is not unique';
    END IF;
    v_next := replace(v_definition,v_old,v_new);
    EXECUTE v_next;
  ELSIF position(v_new IN v_definition) = 0 THEN
    RAISE EXCEPTION
      'finish-certificate readiness call changed; inspect before applying';
  END IF;
END;
$make_finish_certificate_candidate_aware$;

DO $verify$
DECLARE
  v_bad bigint;
  v_trigger_enabled "char";
  v_receipt_trigger_enabled "char";
  v_certificate_source text;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.tournaments t
   WHERE upper(t.status::text) IN ('COMPLETED','CANCELLED')
     AND (
       COALESCE(t.on_break,false)
       OR t.break_started_at IS NOT NULL
       OR t.break_ends_at IS NOT NULL
     );
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'terminal tournament break normalization left % invalid rows',v_bad;
  END IF;

  SELECT tg.tgenabled INTO v_trigger_enabled
    FROM pg_trigger tg
   WHERE tg.tgrelid='public.tournaments'::regclass
     AND tg.tgname='aaa_guard_terminal_tournament_break_state'
     AND NOT tg.tgisinternal;
  SELECT tg.tgenabled INTO v_receipt_trigger_enabled
    FROM pg_trigger tg
   WHERE tg.tgrelid='public.tournament_terminal_break_normalization_receipts'::regclass
     AND tg.tgname='tournament_terminal_break_normalization_receipt_immutable'
     AND NOT tg.tgisinternal;
  IF v_trigger_enabled IS DISTINCT FROM 'O'
     OR v_receipt_trigger_enabled IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'terminal tournament break guards are not enabled';
  END IF;

  IF has_table_privilege('service_role',
       'public.tournament_terminal_break_normalization_receipts','INSERT')
     OR has_table_privilege('service_role',
       'public.tournament_terminal_break_normalization_receipts','UPDATE')
     OR has_table_privilege('service_role',
       'public.tournament_terminal_break_normalization_receipts','DELETE') THEN
    RAISE EXCEPTION 'service role can forge terminal break normalization receipts';
  END IF;

  SELECT p.prosrc INTO STRICT v_certificate_source
    FROM pg_proc p
   WHERE p.oid =
         'public.fn_guard_tournament_completed_certificate()'::regprocedure;
  IF position(
       $$smarter_private.fn_tournament_finish_readiness_for_terminal_candidate($$
       IN v_certificate_source
     ) = 0 THEN
    RAISE EXCEPTION 'finish certificate is not candidate-aware';
  END IF;
  IF position($$IF COALESCE(NEW.on_break,false) THEN$$ IN v_certificate_source)=0 THEN
    RAISE EXCEPTION 'finish certificate no longer rejects a dirty NEW candidate';
  END IF;

  IF has_function_privilege(
       'service_role',
       'smarter_private.fn_tournament_finish_readiness_for_terminal_candidate(uuid,uuid,text,boolean,timestamp with time zone,timestamp with time zone)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'service role can invoke the private finish candidate adapter';
  END IF;
END;
$verify$;

COMMIT;
