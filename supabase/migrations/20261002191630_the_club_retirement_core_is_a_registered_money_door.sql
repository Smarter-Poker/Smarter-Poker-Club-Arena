-- THE CLUB RETIREMENT CORE IS A REGISTERED MONEY DOOR (2026-10-02)
--
-- Migration 20261002152925_club_retirement_safe_unwind renamed the original
-- fn_retire_settled_club(uuid,text,text) to fn_retire_settled_club_core_20260906
-- and put a new owner-facing wrapper of the old name in front of it. The
-- registry row stayed with the name (fn_retire_settled_club); the body that
-- writes clubs.chip_treasury moved to a name the registry had never seen. So
-- fn_ca_money_rpc_drift() reported it and the midway burn-in gate failed
-- no_unregistered_money_rpcs = 1.
--
-- The core is not a leftover: the wrapper calls it for every retirement. It is
-- the same audited retained-record authority, now private (service_role only,
-- revoked from anon and authenticated, asserted by 20261002152925). It is
-- registered here as approved, the way the earlier *_core_YYYYMMDD
-- subroutines are. No function body changes.
-- @live-proof: EXISTS (SELECT 1 FROM public.ca_money_rpc_registry WHERE proname = 'fn_retire_settled_club_core_20260906' AND status = 'approved')

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.fn_retire_settled_club_core_20260906(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'CLUB_RETIREMENT_CORE_MISSING';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_retire_settled_club_core_20260906(uuid,text,text)','EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_retire_settled_club_core_20260906(uuid,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'CLUB_RETIREMENT_PRIVATE_CORE_EXPOSED';
  END IF;
END
$pre$;

INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES (
  'fn_retire_settled_club_core_20260906','approved',
  'Private retained-record retirement core (renamed from fn_retire_settled_club by 20261002152925). Called only by the fn_retire_settled_club wrapper after its welcome unwind and opening-grant checks; rechecks every balance and obligation, writes the audit trail and flips lifecycle. service_role only.'
) ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;

DO $assert$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prokind='f'
       AND p.proname LIKE 'fn_retire_settled_club%'
       AND public.fn_ca_money_rpc_writes_balances(p.prosrc)
       AND NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g WHERE g.proname=p.proname)
  ) THEN
    RAISE EXCEPTION 'CLUB_RETIREMENT_MONEY_DOOR_UNREGISTERED';
  END IF;
END
$assert$;

COMMIT;
