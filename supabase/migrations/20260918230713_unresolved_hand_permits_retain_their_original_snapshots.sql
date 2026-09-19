-- A completed snapshot is not disposable while its original hand permit is
-- reserved. EarlyBird's completed, unaccepted preflop witness crossed the
-- six-hour pruning threshold while its permit was unresolved. The old pruner
-- ignored that custody and could delete evidence required by the owning F06
-- disposition. Preserve that exact table/hand until its permit resolves.
-- This changes only the existing retention predicate. No new schedule, repair
-- path, payout, snapshot reconstruction, permit mutation or engine change.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $snapshot_retention$
DECLARE target oid := to_regprocedure('public.sp_prune_hand_state_snapshots(integer)');
        before_metadata jsonb;
        after_metadata jsonb;
        original text;
        replacement text;
BEGIN
 IF current_user <> 'postgres' OR target IS NULL
 OR md5(pg_get_functiondef(target)) IS DISTINCT FROM '098d76207f7f8fbcea3cc30ea06f36fd'
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole
   AND prosecdef AND proacl::text='{postgres=X/postgres,service_role=X/postgres}'
   AND proconfig=ARRAY['search_path=public']::text[]) THEN
  RAISE EXCEPTION 'F06_SNAPSHOT_RETENTION_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('smarter_private.f06_hand_permits')
   AND relkind='r' AND relowner='postgres'::regrole)
 OR EXISTS(SELECT 1 FROM (VALUES('table_id','uuid'),('hand_number','bigint'),('state','text')) required(name,kind)
   WHERE NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('smarter_private.f06_hand_permits')
      AND attname=required.name AND atttypid=to_regtype(required.kind) AND NOT attisdropped)) THEN
  RAISE EXCEPTION 'F06_SNAPSHOT_RETENTION_DEPENDENCY_CHANGED' USING ERRCODE='55000';
 END IF;
 SELECT to_jsonb(p)-'prosrc' INTO before_metadata FROM pg_proc p WHERE oid=target;
 original := pg_get_functiondef(target);
 replacement := replace(original,$before$      select id from public.hand_state_snapshots
       where (is_complete = true  and created_at < now() - interval '6 hours')
          or (is_complete = false and created_at < now() - interval '30 days')$before$,$after$      select s.id from public.hand_state_snapshots s
       where ((s.is_complete = true  and s.created_at < now() - interval '6 hours')
          or (s.is_complete = false and s.created_at < now() - interval '30 days'))
         -- A completed snapshot can still be the only original witness for an
         -- interrupted hand. Its permit, not the age/completion bit, proves
         -- whether the owning hand transition has resolved that custody.
         and not exists (
           select 1 from smarter_private.f06_hand_permits p
            where p.table_id = s.table_id and p.hand_number = s.hand_number
              and p.state = 'reserved')$after$);
 IF replacement=original OR md5(replacement) IS DISTINCT FROM 'ee1166d02463fdec606f82eb5f27534d' THEN
  RAISE EXCEPTION 'F06_SNAPSHOT_RETENTION_COMPOSITION_CHANGED' USING ERRCODE='55000';
 END IF;
 EXECUTE replacement;
 SELECT to_jsonb(p)-'prosrc' INTO after_metadata FROM pg_proc p WHERE oid=target;
 IF after_metadata IS DISTINCT FROM before_metadata
 OR pg_get_functiondef(target) IS DISTINCT FROM replacement THEN
  RAISE EXCEPTION 'F06_SNAPSHOT_RETENTION_POSTIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
END $snapshot_retention$;

COMMENT ON FUNCTION public.sp_prune_hand_state_snapshots(integer) IS
 'Existing two-minute retention: completed snapshots older than six hours and incomplete snapshots older than thirty days, except an exact table/hand with a reserved F06 permit. Retain original evidence until its owning transition resolves; existing batches and time budget are unchanged.';
COMMIT;
