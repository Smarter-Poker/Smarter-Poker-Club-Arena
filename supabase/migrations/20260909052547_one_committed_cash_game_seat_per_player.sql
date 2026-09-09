-- A committed player may own only one live chair per cash game.
-- The former cluster tick paid away a duplicate chair without engine hand authority.
-- Enforce ownership at commit instead: destination-first atomic moves remain legal.
-- An occupied parent always has a scope (standalone tables use their own namespace), so
-- assigning a previously standalone table to a cluster cannot evade the FK cascade.
-- Scope stamps are derived, CHECK/FK validated, and independent of the move GUC.
-- Old empty parents are initialized within their first admission transaction.
-- Only occupied parents are backfilled: the production inventory has 203,451
-- historical tables but 1,678 active seats. No broad historical UPDATE is needed.
-- No wallet, journal, stack, or departure is repaired by this migration.
-- Live read-only preflight 2026-09-09 found zero duplicate active ownership groups.
-- Publication requires isolated concurrency/move tests and trigger/backfill review.
BEGIN;
SET LOCAL search_path TO public,pg_temp;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.tables, public.table_seats IN ACCESS EXCLUSIVE MODE;
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
    WHERE s.left_at IS NULL AND s.user_id IS NOT NULL
    GROUP BY s.user_id, CASE WHEN t.cluster_id IS NULL THEN 'table:'||t.id::text ELSE 'cluster:'||t.cluster_id::text END
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate committed game ownership requires transaction-level investigation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.table_seats s LEFT JOIN public.tables t ON t.id=s.table_id
             WHERE s.left_at IS NULL AND (t.id IS NULL OR s.user_id IS NULL)) THEN
    RAISE EXCEPTION 'Active seat is missing its table or player';
  END IF;
END
$guard$;
-- This derived key is not an operator rule and must not create a new contract
-- version (or a capture incident) when the metadata column is initialized.
DO $contract$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('public.fn_managed_game_contract_document(text,jsonb)'::regprocedure) INTO definition;
  IF md5(definition) IN ('154901c4d25f28060e81bc06619e788a','6a8019cb24b5a8a42645b9de3aaf48ef') THEN RETURN; END IF;
  IF md5(definition)<>'13df6027a54258c61e6e41275fbf0dd6' THEN
    RAISE EXCEPTION 'Unreviewed managed-game contract projection; scope metadata exclusion requires review';
  END IF;
  definition := replace(definition,$old$'bomb_pot_next_due_at', 'engine_lease_owner', 'engine_lease_expires_at'$old$,$new$'bomb_pot_next_due_at', 'engine_lease_owner', 'engine_lease_expires_at', 'seat_game_scope'$new$);
  IF md5(definition)<>'154901c4d25f28060e81bc06619e788a' THEN RAISE EXCEPTION 'Unexpected contract projection patch'; END IF;
  EXECUTE definition;
END
$contract$;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS seat_game_scope text;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS active_game_scope text;
CREATE OR REPLACE FUNCTION public.fn_stamp_table_game_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  NEW.seat_game_scope := CASE WHEN NEW.cluster_id IS NULL
    THEN 'table:'||NEW.id::text ELSE 'cluster:'||NEW.cluster_id::text END;
  RETURN NEW;
END
$function$;
CREATE OR REPLACE FUNCTION public.fn_stamp_active_seat_game_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    NEW.active_game_scope := NULL;
  ELSE
    SELECT t.seat_game_scope INTO NEW.active_game_scope FROM public.tables t WHERE t.id=NEW.table_id;
    IF NOT FOUND OR NEW.user_id IS NULL THEN
      RAISE EXCEPTION 'Active seat requires an existing table and player' USING ERRCODE='23514';
    END IF;
    IF NEW.active_game_scope IS NULL THEN
      -- A pre-migration empty table has no cached scope. Initialize only that
      -- parent, inside this admission transaction. Existing occupied tables
      -- never take this UPDATE path. Concurrent initialization is idempotent.
      UPDATE public.tables t SET seat_game_scope = CASE WHEN t.cluster_id IS NULL
        THEN 'table:'||t.id::text ELSE 'cluster:'||t.cluster_id::text END
      WHERE t.id=NEW.table_id AND t.seat_game_scope IS NULL;
      SELECT t.seat_game_scope INTO NEW.active_game_scope FROM public.tables t WHERE t.id=NEW.table_id;
      IF NEW.active_game_scope IS NULL THEN
        RAISE EXCEPTION 'Active seat parent scope initialization failed' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.fn_stamp_table_game_scope() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_stamp_active_seat_game_scope() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS zzzz_stamp_table_game_scope ON public.tables;
CREATE TRIGGER zzzz_stamp_table_game_scope BEFORE INSERT OR UPDATE ON public.tables
FOR EACH ROW EXECUTE FUNCTION public.fn_stamp_table_game_scope();
DROP TRIGGER IF EXISTS zzzz_stamp_active_seat_game_scope ON public.table_seats;
CREATE TRIGGER zzzz_stamp_active_seat_game_scope BEFORE INSERT OR UPDATE ON public.table_seats
FOR EACH ROW EXECUTE FUNCTION public.fn_stamp_active_seat_game_scope();
-- Prove that existing triggers do not turn a metadata backfill into a seat
-- or game mutation. Keep this proof transaction-local; it is not a monitor.
CREATE TEMP TABLE ca_scope_parent_proof ON COMMIT DROP AS
SELECT t.id, to_jsonb(t)-'seat_game_scope'-'updated_at' AS original
FROM public.tables t WHERE EXISTS
  (SELECT 1 FROM public.table_seats s WHERE s.table_id=t.id AND s.left_at IS NULL);
CREATE TEMP TABLE ca_scope_seat_proof ON COMMIT DROP AS
SELECT s.id,to_jsonb(s)-'active_game_scope' AS original
FROM public.table_seats s WHERE s.left_at IS NULL;
UPDATE public.tables SET seat_game_scope = CASE WHEN cluster_id IS NULL THEN 'table:'||id::text ELSE 'cluster:'||cluster_id::text END
WHERE seat_game_scope IS DISTINCT FROM CASE WHEN cluster_id IS NULL THEN 'table:'||id::text ELSE 'cluster:'||cluster_id::text END
AND EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id=public.tables.id AND s.left_at IS NULL);
UPDATE public.table_seats s SET active_game_scope=t.seat_game_scope FROM public.tables t
WHERE s.table_id=t.id AND s.left_at IS NULL AND s.active_game_scope IS DISTINCT FROM t.seat_game_scope;
DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.tables'::regclass AND conname='table_game_scope_is_derived') THEN
    ALTER TABLE public.tables ADD CONSTRAINT table_game_scope_is_derived CHECK
      (seat_game_scope IS NULL OR seat_game_scope = CASE WHEN cluster_id IS NULL THEN 'table:'||id::text ELSE 'cluster:'||cluster_id::text END);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.tables'::regclass AND conname='table_game_scope_parent_key') THEN
    ALTER TABLE public.tables ADD CONSTRAINT table_game_scope_parent_key UNIQUE(id,seat_game_scope);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.table_seats'::regclass AND conname='active_seat_requires_game_scope') THEN
    ALTER TABLE public.table_seats ADD CONSTRAINT active_seat_requires_game_scope CHECK
      ((left_at IS NULL AND active_game_scope IS NOT NULL AND user_id IS NOT NULL AND table_id IS NOT NULL)
       OR (left_at IS NOT NULL AND active_game_scope IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.table_seats'::regclass AND conname='active_seat_game_scope_parent') THEN
    ALTER TABLE public.table_seats ADD CONSTRAINT active_seat_game_scope_parent
      FOREIGN KEY(table_id,active_game_scope) REFERENCES public.tables(id,seat_game_scope)
      ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.table_seats'::regclass AND conname='one_committed_seat_per_game_player') THEN
    ALTER TABLE public.table_seats ADD CONSTRAINT one_committed_seat_per_game_player
      UNIQUE(user_id,active_game_scope) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$constraints$;
-- IF NOT EXISTS is replay support, not permission to accept a different rule.
DO $catalog$
DECLARE expected record; actual text;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('tables','table_game_scope_is_derived','CHECK (((seat_game_scope IS NULL) OR (seat_game_scope = CASE WHEN (cluster_id IS NULL) THEN (''table:''::text || (id)::text) ELSE (''cluster:''::text || (cluster_id)::text) END)))'),
    ('tables','table_game_scope_parent_key','UNIQUE (id, seat_game_scope)'),
    ('table_seats','active_seat_requires_game_scope','CHECK ((((left_at IS NULL) AND (active_game_scope IS NOT NULL) AND (user_id IS NOT NULL) AND (table_id IS NOT NULL)) OR ((left_at IS NOT NULL) AND (active_game_scope IS NULL))))'),
    ('table_seats','active_seat_game_scope_parent','FOREIGN KEY (table_id, active_game_scope) REFERENCES tables(id, seat_game_scope) ON UPDATE CASCADE'),
    ('table_seats','one_committed_seat_per_game_player','UNIQUE (user_id, active_game_scope) DEFERRABLE INITIALLY DEFERRED')
  ) AS specification(table_name,constraint_name,definition)
  LOOP
    SELECT pg_get_constraintdef(c.oid) INTO actual FROM pg_constraint c
    WHERE c.conrelid=('public.'||expected.table_name)::regclass
      AND c.conname=expected.constraint_name AND c.convalidated;
    IF regexp_replace(actual,'[[:space:]]+',' ','g') IS DISTINCT FROM
       regexp_replace(expected.definition,'[[:space:]]+',' ','g') THEN
      RAISE EXCEPTION 'Unreviewed ownership constraint %', expected.constraint_name;
    END IF;
  END LOOP;
END
$catalog$;
DO $proof$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_temp.ca_scope_parent_proof p LEFT JOIN public.tables t ON t.id=p.id
    WHERE t.id IS NULL OR p.original IS DISTINCT FROM to_jsonb(t)-'seat_game_scope'-'updated_at')
    OR EXISTS (SELECT 1 FROM pg_temp.ca_scope_seat_proof p LEFT JOIN public.table_seats s ON s.id=p.id
    WHERE s.id IS NULL OR p.original IS DISTINCT FROM to_jsonb(s)-'active_game_scope')
  THEN RAISE EXCEPTION 'Scope backfill changed existing game or seat data; entire migration refused'; END IF;
END
$proof$;
COMMIT;
