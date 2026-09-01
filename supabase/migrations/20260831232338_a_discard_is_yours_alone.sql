-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831232338; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE TABLE IF NOT EXISTS public.hand_discards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  user_id uuid NOT NULL,
  seat_number integer NOT NULL,
  discarded_card jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (table_id, hand_number, user_id)
);

CREATE INDEX IF NOT EXISTS hand_discards_user_recent_idx
  ON public.hand_discards (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hand_discards_hand_idx
  ON public.hand_discards (table_id, hand_number);

ALTER TABLE public.hand_discards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hand_discards_read_own ON public.hand_discards;
CREATE POLICY hand_discards_read_own ON public.hand_discards
  FOR SELECT
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS hand_discards_block_insert ON public.hand_discards;
CREATE POLICY hand_discards_block_insert ON public.hand_discards
  FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS hand_discards_block_update ON public.hand_discards;
CREATE POLICY hand_discards_block_update ON public.hand_discards
  FOR UPDATE TO authenticated USING (false);

DROP POLICY IF EXISTS hand_discards_block_delete ON public.hand_discards;
CREATE POLICY hand_discards_block_delete ON public.hand_discards
  FOR DELETE TO authenticated USING (false);

REVOKE ALL ON public.hand_discards FROM anon;
GRANT SELECT ON public.hand_discards TO authenticated;
GRANT ALL ON public.hand_discards TO service_role;

COMMENT ON TABLE public.hand_discards IS
  'Crazy Pineapple: the card each player threw, readable ONLY by that player. Never in hand_history - its RLS lets any seat in the hand read the whole row, and a discard is never revealed to opponents. Written by the engine with the service role.';

CREATE OR REPLACE FUNCTION public.sp_prune_hand_discards(p_limit integer DEFAULT 5000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  WITH doomed AS (
    SELECT d.id
    FROM public.hand_discards d
    WHERE d.created_at < now() - interval '1 day'
      AND NOT EXISTS (
        SELECT 1 FROM public.hand_history h
        WHERE h.table_id = d.table_id AND h.hand_number = d.hand_number
      )
    ORDER BY d.created_at
    LIMIT GREATEST(p_limit, 0)
  )
  DELETE FROM public.hand_discards d
  USING doomed WHERE d.id = doomed.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.sp_prune_hand_discards(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sp_prune_hand_discards(integer) TO service_role;

COMMENT ON FUNCTION public.sp_prune_hand_discards(integer) IS
  'Deletes hand_discards rows whose hand is no longer in hand_history, after a one-day grace window so a discard written mid-hand is never pruned before its own hand row is written.';
