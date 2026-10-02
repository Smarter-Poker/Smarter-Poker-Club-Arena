-- 20261002201605_spin_deactivation_names_the_reserve_row
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-02 20:16:05 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
-- A Spin seed return must name the reserve row whose balance it debits.
--
-- fn_spin_deactivate resolves a club or union to its reserve owner in v_owner,
-- then locks the concrete spin_bonus_pools row in v_pool. Its balance update is
-- on that row, so the canonical chip-ledger leg must carry v_pool.id. The old
-- leg carried v_owner instead. For standalone clubs those UUIDs are different,
-- leaving a -seed journal movement against an account whose measured balance
-- delta was zero; the deferred store-conservation guard correctly refused the
-- whole transaction. No balance or historical row is changed here.
-- @live-proof: position($needle$(v_actor, 'spin_reserve', v_pool.id, 'spin_bonus_pools.balance',$needle$ in pg_get_functiondef('public.fn_spin_deactivate(uuid,uuid)'::regprocedure)) > 0

BEGIN;

SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '30s';

DO $rewrite_spin_deactivation_reserve_identity$
DECLARE
  v_oid oid := to_regprocedure('public.fn_spin_deactivate(uuid,uuid)');
  v_before text;
  v_after text;
  v_old text := $old$(v_actor, 'spin_reserve', v_owner, 'spin_bonus_pools.balance',$old$;
  v_new text := $new$(v_actor, 'spin_reserve', v_pool.id, 'spin_bonus_pools.balance',$new$;
  v_count integer;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'SPIN_DEACTIVATION_FUNCTION_MISSING';
  END IF;

  v_before := pg_get_functiondef(v_oid);
  v_count := (length(v_before) - length(replace(v_before, v_old, ''))) / length(v_old);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SPIN_DEACTIVATION_RESERVE_IDENTITY_DRIFT: %', v_count;
  END IF;

  v_after := replace(v_before, v_old, v_new);
  EXECUTE v_after;

  IF replace(pg_get_functiondef(v_oid), v_new, v_old) IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'SPIN_DEACTIVATION_RESERVE_IDENTITY_REVERSE_SUBSTITUTION_FAILED';
  END IF;
END
$rewrite_spin_deactivation_reserve_identity$;

COMMIT;
