-- 20260928152513_a_time_bank_debit_carries_its_own_id_and_a_receipt.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A TIME BANK DEBIT CARRIES ITS OWN ID AND A RECEIPT (2026-09-28)
--
-- What was wrong
-- --------------
-- public.fn_consume_time_bank(uuid, integer) debits a player's time bank
-- (VIP monthly seconds, then purchased uses) and takes no key. When the
-- engine's call timed out, the engine could not tell whether the debit had
-- committed, and it could not ask again: a second call would charge the
-- player twice. So it set timeBankAccountingUnconfirmed = true on that table
-- and NOTHING ever cleared it.
--
-- A table in that state can never park for the hourly break and, once
-- stopped, can never write its stopped time-bank custody, so its tournament
-- manager can never finish its stop. Measured 2026-09-28:
--   * 12:17:06Z one fn_consume_time_bank call returned supabase_timeout;
--   * 12:19:51Z tournament 87a68e55 ("$100 Freeroll 6:00 AM", 335 players on
--     43 tables) lost its lease and its stop failed on table 9333d016
--     ("retained time-bank custody"); the manager was quarantined and retried
--     80+ times; the event dealt nothing from 12:19Z;
--   * /health maintenance.unparkedReasons: stopped_bank_custody_unreadable 1,
--     then accounting_unconfirmed 55: the restart gate stayed shut for three
--     consecutive breaks, so no engine release could land.
--
-- What this adds
-- --------------
--   * smarter_private.time_bank_debit_receipts: one append-only row per debit
--     id, written in the SAME transaction as the debit, holding its result.
--   * public.fn_consume_time_bank_once(user, seconds, debit_id): takes the
--     same per-user advisory lock as the debit, returns the stored receipt if
--     this id already committed, and otherwise performs the unchanged
--     fn_consume_time_bank and records its receipt. Asking again with the same
--     id is therefore exactly-once: it either reports the earlier commit or
--     applies the debit now, never both. An id reused with a different user or
--     amount is refused.
--
-- The engine (same change) sends every debit through this door with a fresh
-- id, keeps the id of any debit whose answer was lost, and asks again at the
-- two places the answer matters (the restart gate's census and the manager's
-- stop). fn_consume_time_bank itself is unchanged and is guarded on its exact
-- production pre-image, because the new door delegates to it.
--
-- It moves no chips. The only balances it touches are the ones
-- fn_consume_time_bank already touches, exactly as before.
--
-- @live-proof: to_regclass('smarter_private.time_bank_debit_receipts') IS NOT NULL
-- @live-proof: to_regprocedure('public.fn_consume_time_bank_once(uuid,integer,uuid)') IS NOT NULL

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE
  r record;
BEGIN
  SELECT pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl, p.proconfig::text AS cfg,
         p.prosecdef AS secdef, md5(p.prosrc) AS body
    INTO r
    FROM pg_proc p
   WHERE p.oid = 'public.fn_consume_time_bank(uuid,integer)'::regprocedure;
  IF r.body IS DISTINCT FROM '7832bfb717daaeb625372bdd3ccc7d60'
     OR r.owner IS DISTINCT FROM 'postgres'
     OR r.acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
     OR r.cfg IS DISTINCT FROM '{search_path=public}'
     OR r.secdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREIMAGE: fn_consume_time_bank is not the reviewed definition (body %, acl %)', r.body, r.acl;
  END IF;
  IF to_regclass('smarter_private.time_bank_debit_receipts') IS NOT NULL
     OR to_regprocedure('public.fn_consume_time_bank_once(uuid,integer,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREIMAGE: the time bank debit receipt objects already exist';
  END IF;
END
$pre$;

CREATE TABLE smarter_private.time_bank_debit_receipts (
  debit_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  seconds integer NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE smarter_private.time_bank_debit_receipts IS
  'Append-only receipt of one engine time bank debit, written in the debit''s own transaction by fn_consume_time_bank_once, so a debit whose answer was lost can be asked about again by its id without charging twice. 2026-09-28.';

ALTER TABLE smarter_private.time_bank_debit_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE smarter_private.time_bank_debit_receipts FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION smarter_private.time_bank_debit_receipt_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  RAISE EXCEPTION 'TIME_BANK_DEBIT_RECEIPT_IMMUTABLE: a debit receipt is never changed or removed'
    USING ERRCODE = '55000';
END;
$function$;

REVOKE ALL ON FUNCTION smarter_private.time_bank_debit_receipt_immutable() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER time_bank_debit_receipt_immutable
  BEFORE UPDATE OR DELETE ON smarter_private.time_bank_debit_receipts
  FOR EACH ROW EXECUTE FUNCTION smarter_private.time_bank_debit_receipt_immutable();

CREATE TRIGGER time_bank_debit_receipt_no_truncate
  BEFORE TRUNCATE ON smarter_private.time_bank_debit_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.time_bank_debit_receipt_immutable();

CREATE FUNCTION public.fn_consume_time_bank_once(p_user_id uuid, p_seconds integer, p_debit_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE
  v_receipt smarter_private.time_bank_debit_receipts;
  v_result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'fn_consume_time_bank_once is engine-only' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_debit_id IS NULL OR p_seconds IS NULL THEN
    RAISE EXCEPTION 'TIME_BANK_DEBIT_ARGUMENTS_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- The same lock fn_consume_time_bank takes, taken first: a re-ask that
  -- arrives while the original is still running waits for it and then reads
  -- its receipt instead of racing it.
  PERFORM pg_advisory_xact_lock(hashtextextended('time_bank:' || p_user_id::text, 0));

  SELECT * INTO v_receipt FROM smarter_private.time_bank_debit_receipts WHERE debit_id = p_debit_id;
  IF FOUND THEN
    IF v_receipt.user_id IS DISTINCT FROM p_user_id OR v_receipt.seconds IS DISTINCT FROM p_seconds THEN
      RAISE EXCEPTION 'TIME_BANK_DEBIT_ID_REUSED' USING ERRCODE = '22023';
    END IF;
    RETURN v_receipt.result
      || jsonb_build_object('receipted', true, 'replayed', true, 'debit_id', p_debit_id);
  END IF;

  v_result := public.fn_consume_time_bank(p_user_id, p_seconds);

  INSERT INTO smarter_private.time_bank_debit_receipts (debit_id, user_id, seconds, result)
  VALUES (p_debit_id, p_user_id, p_seconds, v_result);

  RETURN v_result || jsonb_build_object('receipted', true, 'replayed', false, 'debit_id', p_debit_id);
END;
$function$;

COMMENT ON FUNCTION public.fn_consume_time_bank_once(uuid, integer, uuid) IS
  'Engine-only, exactly-once time bank debit keyed by debit id: returns the stored receipt if this id committed, otherwise performs fn_consume_time_bank and records its receipt in the same transaction. 2026-09-28.';

REVOKE ALL ON FUNCTION public.fn_consume_time_bank_once(uuid, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_consume_time_bank_once(uuid, integer, uuid) TO service_role;

DO $post$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_consume_time_bank(uuid,integer)'::regprocedure))
     IS DISTINCT FROM '7832bfb717daaeb625372bdd3ccc7d60' THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_consume_time_bank changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_consume_time_bank_once(uuid,integer,uuid)'::regprocedure
       AND p.prosecdef
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_consume_time_bank_once is not engine-only';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'smarter_private.time_bank_debit_receipts'::regclass AND NOT tgisinternal) <> 2 THEN
    RAISE EXCEPTION 'POSTIMAGE: the debit receipt is not append-only';
  END IF;
END
$post$;

COMMIT;
