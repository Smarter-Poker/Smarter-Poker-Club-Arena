-- A knockout status and the bounty it creates are one durable operation.
--
-- New engines use fn_claim_tournament_bounty_elimination, whose status CAS and
-- outbox row commit together. Recovery consumes that durable outbox only; it
-- never infers or creates a money obligation from mutable historical rows.

-- The entire authority change is one transaction. This is both the financial
-- boundary (no caller can observe half of the payout contract) and the schema
-- cache boundary (PostgREST receives one coalesced reload notification). The
-- short lock timeout makes a contended rollout fail before changing authority;
-- deployment must drain engine writers because lock_timeout does not bound how
-- long a lock is held after acquisition.
BEGIN;
SET LOCAL lock_timeout = '250ms';

CREATE TABLE IF NOT EXISTS public.tournament_bounty_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  eliminated_user_id uuid NOT NULL,
  -- Immutable identity only, deliberately not a foreign key. Tournament table
  -- rows are retired after completion; an audit/outbox record must not block
  -- that lifecycle or disappear with it. Membership is proven while claiming.
  table_id uuid NOT NULL,
  -- Deliberately not a foreign key. Horse-only hand histories have a bounded
  -- retention window, while this immutable audit identity must survive the
  -- normal hand-history pruner.
  hand_id uuid NOT NULL,
  hand_number bigint NOT NULL CHECK (hand_number >= 1000000),
  settlement_completed_at timestamptz NOT NULL,
  seat_joined_at timestamptz NOT NULL,
  position integer NOT NULL CHECK (position >= 2),
  prize numeric(20,2) NOT NULL CHECK (prize >= 0),
  bubble_refund numeric(20,2) NOT NULL DEFAULT 0 CHECK (bubble_refund >= 0),
  mode text NOT NULL CHECK (mode IN ('regular','pko','mystery_pre','mystery_chest')),
  activation_generation bigint NOT NULL DEFAULT 0 CHECK (activation_generation >= 0),
  head_amount numeric(20,2) NOT NULL CHECK (head_amount > 0),
  knocker_user_id uuid NOT NULL,
  claimants jsonb NOT NULL CHECK (jsonb_typeof(claimants) = 'array'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','settled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CHECK ((mode='mystery_chest' AND activation_generation>0)
      OR (mode<>'mystery_chest' AND activation_generation=0)),
  UNIQUE (tournament_id, eliminated_user_id, seat_joined_at),
  UNIQUE (tournament_id, hand_number, eliminated_user_id)
);

CREATE INDEX IF NOT EXISTS idx_tournament_bounty_obligations_pending
  ON public.tournament_bounty_obligations (next_attempt_at, created_at)
  WHERE state = 'pending';

ALTER TABLE public.tournament_bounty_obligations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_bounty_obligations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.tournament_bounty_obligations TO service_role;

-- Ledger rows acknowledge an outbox by trigger, so browser DML on the ledger
-- would be equivalent to browser authority to mark money paid. Existing live
-- RLS currently has only SELECT, but raw DML grants make a future permissive
-- policy an instant payout bypass. Make the privilege invariant intrinsic.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.tournament_bounties FROM PUBLIC, anon, authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.tournament_bounty_awards FROM PUBLIC, anon, authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.tournament_bounty_award_recipients FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.tournament_bounties,
  public.tournament_bounty_awards,
  public.tournament_bounty_award_recipients TO service_role;
DO $do$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname
      FROM pg_policies
     WHERE schemaname='public'
       AND tablename IN ('tournament_bounties','tournament_bounty_awards',
                         'tournament_bounty_award_recipients')
       AND cmd IN ('ALL','INSERT','UPDATE','DELETE')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I',p.policyname,p.schemaname,p.tablename);
  END LOOP;
END;
$do$;

-- A user may re-enter and be knocked out more than once.  The historical
-- uniqueness keys used only (tournament,user), which made the second head
-- impossible to pay.  Every new ledger/award row is instead tied to the
-- immutable seat-generation outbox id.  Legacy writers retain their old
-- uniqueness only while they have no outbox id.
ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS mystery_bounty_activation_generation bigint NOT NULL DEFAULT 0;

-- Normalize pre-existing active/complete rows before validating the invariant.
UPDATE public.tournaments
   SET mystery_bounty_activation_generation=1
 WHERE mystery_bounty_stage IN ('active','complete')
   AND mystery_bounty_activation_generation=0;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.tournaments'::regclass
       AND conname='tournaments_mystery_activation_generation_nonnegative'
  ) THEN
    ALTER TABLE public.tournaments
      ADD CONSTRAINT tournaments_mystery_activation_generation_nonnegative
      CHECK (mystery_bounty_activation_generation>=0) NOT VALID;
  END IF;
END;
$do$;

-- VALIDATE takes SHARE UPDATE EXCLUSIVE rather than ACCESS EXCLUSIVE and can
-- scan the existing rows without stopping tournament DML.
ALTER TABLE public.tournaments
  VALIDATE CONSTRAINT tournaments_mystery_activation_generation_nonnegative;

ALTER TABLE public.tournament_bounties
  ADD COLUMN IF NOT EXISTS bounty_obligation_id uuid;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.tournament_bounties'::regclass
       AND conname='tournament_bounties_bounty_obligation_id_fkey'
  ) THEN
    ALTER TABLE public.tournament_bounties
      ADD CONSTRAINT tournament_bounties_bounty_obligation_id_fkey
      FOREIGN KEY (bounty_obligation_id)
      REFERENCES public.tournament_bounty_obligations(id) ON DELETE RESTRICT
      NOT VALID;
  END IF;
END;
$do$;

ALTER TABLE public.tournament_bounties
  VALIDATE CONSTRAINT tournament_bounties_bounty_obligation_id_fkey;

-- A prior draft could have left an invalid concurrent-build shell. Remove only
-- that invalid shell before building the transaction-owned replacement.
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_index i ON i.indexrelid=c.oid
     WHERE n.nspname='public' AND c.relname='uq_tourney_bounty_ko_legacy'
       AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.uq_tourney_bounty_ko_legacy';
  END IF;
END;
$do$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tourney_bounty_ko_legacy
  ON public.tournament_bounties(tournament_id, eliminated_player_id, collector_player_id)
  WHERE bounty_obligation_id IS NULL;
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_index i ON i.indexrelid=c.oid
     WHERE n.nspname='public' AND c.relname='uq_tourney_bounty_ko_generation'
       AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.uq_tourney_bounty_ko_generation';
  END IF;
END;
$do$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tourney_bounty_ko_generation
  ON public.tournament_bounties(bounty_obligation_id, collector_player_id)
  WHERE bounty_obligation_id IS NOT NULL;

ALTER TABLE public.tournament_bounty_awards
  ADD COLUMN IF NOT EXISTS bounty_obligation_id uuid;
ALTER TABLE public.tournament_bounty_awards
  ADD COLUMN IF NOT EXISTS activation_generation bigint;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.tournament_bounty_awards'::regclass
       AND conname='tournament_bounty_awards_bounty_obligation_id_fkey'
  ) THEN
    ALTER TABLE public.tournament_bounty_awards
      ADD CONSTRAINT tournament_bounty_awards_bounty_obligation_id_fkey
      FOREIGN KEY (bounty_obligation_id)
      REFERENCES public.tournament_bounty_obligations(id) ON DELETE RESTRICT
      NOT VALID;
  END IF;
END;
$do$;

ALTER TABLE public.tournament_bounty_awards
  VALIDATE CONSTRAINT tournament_bounty_awards_bounty_obligation_id_fkey;

UPDATE public.tournament_bounty_awards a
   SET activation_generation=t.mystery_bounty_activation_generation
  FROM public.tournaments t
 WHERE t.id=a.tournament_id AND a.activation_generation IS NULL
   AND t.mystery_bounty_activation_generation>0;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.tournament_bounty_awards'::regclass
       AND conname='tournament_bounty_awards_bound_generation_present'
  ) THEN
    ALTER TABLE public.tournament_bounty_awards
      ADD CONSTRAINT tournament_bounty_awards_bound_generation_present
      CHECK (bounty_obligation_id IS NULL OR activation_generation IS NOT NULL)
      NOT VALID;
  END IF;
END;
$do$;

ALTER TABLE public.tournament_bounty_awards
  VALIDATE CONSTRAINT tournament_bounty_awards_bound_generation_present;

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_index i ON i.indexrelid=c.oid
     WHERE n.nspname='public' AND c.relname='uq_tournament_bounty_award_legacy'
       AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.uq_tournament_bounty_award_legacy';
  END IF;
END;
$do$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tournament_bounty_award_legacy
  ON public.tournament_bounty_awards(tournament_id, eliminated_user_id)
  WHERE bounty_obligation_id IS NULL;
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_index i ON i.indexrelid=c.oid
     WHERE n.nspname='public' AND c.relname='uq_tournament_bounty_award_generation'
       AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.uq_tournament_bounty_award_generation';
  END IF;
END;
$do$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tournament_bounty_award_generation
  ON public.tournament_bounty_awards(bounty_obligation_id)
  WHERE bounty_obligation_id IS NOT NULL;

-- IF NOT EXISTS is safe only when a same-named object is proved to be the
-- intended enforcement index. Refuse the migration before retiring either
-- legacy uniqueness key if a prior draft left a valid but differently-shaped
-- index under one of these names.
DO $assert$
DECLARE
  v_expected record;
BEGIN
  FOR v_expected IN
    SELECT * FROM (VALUES
      ('uq_tourney_bounty_ko_legacy',
       'public.tournament_bounties'::regclass,
       ARRAY['tournament_id','eliminated_player_id','collector_player_id']::text[],
       'bounty_obligation_id IS NULL'),
      ('uq_tourney_bounty_ko_generation',
       'public.tournament_bounties'::regclass,
       ARRAY['bounty_obligation_id','collector_player_id']::text[],
       'bounty_obligation_id IS NOT NULL'),
      ('uq_tournament_bounty_award_legacy',
       'public.tournament_bounty_awards'::regclass,
       ARRAY['tournament_id','eliminated_user_id']::text[],
       'bounty_obligation_id IS NULL'),
      ('uq_tournament_bounty_award_generation',
       'public.tournament_bounty_awards'::regclass,
       ARRAY['bounty_obligation_id']::text[],
       'bounty_obligation_id IS NOT NULL')
    ) AS expected(index_name,table_oid,key_columns,predicate)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_index i
        JOIN pg_class index_class ON index_class.oid=i.indexrelid
        JOIN pg_namespace index_namespace ON index_namespace.oid=index_class.relnamespace
        JOIN pg_am access_method ON access_method.oid=index_class.relam
       WHERE index_namespace.nspname='public'
         AND index_class.relname=v_expected.index_name
         AND i.indrelid=v_expected.table_oid
         AND i.indisunique
         AND i.indisvalid
         AND i.indisready
         AND access_method.amname='btree'
         AND i.indnkeyatts=cardinality(v_expected.key_columns)
         AND i.indnatts=cardinality(v_expected.key_columns)
         AND ARRAY(
           SELECT pg_get_indexdef(i.indexrelid,key_position,true)
             FROM generate_series(1,i.indnkeyatts::integer) key_position
             ORDER BY key_position
         )=v_expected.key_columns
         AND pg_get_expr(i.indpred,i.indrelid,true)=v_expected.predicate
    ) THEN
      RAISE EXCEPTION 'replacement bounty index % does not match its required unique key and predicate',
        v_expected.index_name;
    END IF;
  END LOOP;
END;
$assert$;

-- Both replacement key families are now present and proved before either old
-- uniqueness mechanism is retired.
DROP INDEX IF EXISTS public.uq_tourney_bounty_ko;
ALTER TABLE public.tournament_bounty_awards
  DROP CONSTRAINT IF EXISTS tournament_bounty_awards_tournament_id_eliminated_user_id_key;

CREATE TABLE IF NOT EXISTS public.tournament_bounty_completion_receipts (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  winner_user_id uuid,
  mystery_settled_at timestamptz,
  mystery_result jsonb,
  pool_finalized_at timestamptz,
  pool_result jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((mystery_settled_at IS NULL AND mystery_result IS NULL)
      OR (mystery_settled_at IS NOT NULL AND winner_user_id IS NOT NULL
          AND jsonb_typeof(mystery_result)='object')),
  CHECK ((pool_finalized_at IS NULL AND pool_result IS NULL)
      OR (pool_finalized_at IS NOT NULL AND winner_user_id IS NOT NULL
          AND jsonb_typeof(pool_result)='object'))
);
ALTER TABLE public.tournament_bounty_completion_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_bounty_completion_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.tournament_bounty_completion_receipts TO service_role;

CREATE TABLE IF NOT EXISTS public.tournament_final_table_deal_receipts (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  payouts jsonb NOT NULL CHECK (jsonb_typeof(payouts)='array'),
  chip_leader uuid NOT NULL,
  expected_amount numeric(20,2) NOT NULL,
  settled_amount numeric(20,2) NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tournament_final_table_deal_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_final_table_deal_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.tournament_final_table_deal_receipts TO service_role;

-- Mystery activation is a database-serialized phase change, not a timestamp
-- comparison.  The monotonic generation is captured on every bounty debt and
-- the immutable receipt proves which inventory the active phase opened.
CREATE TABLE IF NOT EXISTS public.tournament_mystery_activation_receipts (
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  activation_generation bigint NOT NULL CHECK (activation_generation > 0),
  activated_at timestamptz NOT NULL,
  chest_count integer NOT NULL CHECK (chest_count > 0),
  pool_cents bigint NOT NULL CHECK (pool_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id,activation_generation)
);
ALTER TABLE public.tournament_mystery_activation_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_mystery_activation_receipts
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.tournament_mystery_activation_receipts TO service_role;

INSERT INTO public.tournament_mystery_activation_receipts
  (tournament_id,activation_generation,activated_at,chest_count,pool_cents)
SELECT t.id,t.mystery_bounty_activation_generation,
       COALESCE(t.mystery_bounty_activated_at,t.updated_at,now()),
       inventory.chest_count,inventory.pool_cents
  FROM public.tournaments t
  CROSS JOIN LATERAL (
    SELECT count(*)::integer AS chest_count,COALESCE(sum(c.amount_cents),0)::bigint AS pool_cents
      FROM public.tournament_bounty_chests c WHERE c.tournament_id=t.id
  ) inventory
 WHERE t.mystery_bounty_stage IN ('active','complete')
   AND t.mystery_bounty_activation_generation>0
   AND inventory.chest_count>0 AND inventory.pool_cents>0
ON CONFLICT (tournament_id,activation_generation) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.tournament_pko_settlement_watermarks (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  last_settled_hand_number bigint NOT NULL CHECK (last_settled_hand_number >= 1000000),
  last_obligation_id uuid NOT NULL REFERENCES public.tournament_bounty_obligations(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tournament_pko_settlement_watermarks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_pko_settlement_watermarks
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.tournament_pko_settlement_watermarks TO service_role;

-- Durable, authenticated event bridge into the single engine process. Browser
-- actions commit through their existing RLS/RPC authority; triggers/functions
-- enqueue this row in the SAME transaction. Realtime is the immediate delivery
-- path and the bounded pending-row drain is crash/lost-notification defense.
CREATE TABLE IF NOT EXISTS public.tournament_manager_wakes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz
);
ALTER TABLE public.tournament_manager_wakes
  ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 1 CHECK (generation>0);
ALTER TABLE public.tournament_manager_wakes
  DROP CONSTRAINT IF EXISTS tournament_manager_wakes_reason_check;
ALTER TABLE public.tournament_manager_wakes
  ADD CONSTRAINT tournament_manager_wakes_reason_check
  CHECK (reason IN ('rebuy','reentry','addon','late_registration','deal_vote','bounty_settled'));
CREATE INDEX IF NOT EXISTS idx_tournament_manager_wakes_pending
  ON public.tournament_manager_wakes(created_at,id) WHERE consumed_at IS NULL;
-- One level-triggered receipt per action class. Preserve one oldest pending
-- signal if this migration is resumed after a partial DB-first rollout.
WITH duplicates AS (
  SELECT id,row_number() OVER (PARTITION BY tournament_id,reason ORDER BY id) AS ordinal
    FROM public.tournament_manager_wakes
   WHERE consumed_at IS NULL
)
UPDATE public.tournament_manager_wakes w
   SET consumed_at=clock_timestamp()
  FROM duplicates d
 WHERE w.id=d.id AND d.ordinal>1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tournament_manager_wakes_pending_by_reason
  ON public.tournament_manager_wakes(tournament_id,reason)
  WHERE consumed_at IS NULL;
ALTER TABLE public.tournament_manager_wakes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_manager_wakes FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.tournament_manager_wakes TO service_role;
REVOKE ALL ON SEQUENCE public.tournament_manager_wakes_id_seq
  FROM PUBLIC,anon,authenticated,service_role;

-- Wake functions and grants share the same all-or-nothing authority switch.
CREATE OR REPLACE FUNCTION public.fn_emit_tournament_manager_wake(
  p_tournament_id uuid,
  p_reason text
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_id bigint;
  v_status text;
BEGIN
  IF p_reason NOT IN (
    'rebuy','reentry','addon','late_registration','deal_vote','bounty_settled'
  ) THEN
    RAISE EXCEPTION 'invalid tournament manager wake reason';
  END IF;

  -- Serialize every emitter with the tournament lifecycle transition. UPDATE
  -- takes a NO KEY UPDATE lock, which conflicts with FOR SHARE: an emitter that
  -- commits first is consumed by the terminal AFTER trigger, while an emitter
  -- that arrives second observes the terminal state and cannot strand work for
  -- a manager that has already stopped. Terminal recovery can still settle a
  -- legacy financial obligation; it simply has no live manager to wake.
  SELECT upper(COALESCE(t.status,''))
    INTO v_status
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE='foreign_key_violation';
  END IF;
  IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.tournament_manager_wakes AS pending(tournament_id,reason,generation)
  VALUES (p_tournament_id,p_reason,1)
  ON CONFLICT (tournament_id,reason) WHERE consumed_at IS NULL
  DO UPDATE SET
    generation=pending.generation+1,
    created_at=clock_timestamp()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

-- A DB-first retry of an earlier draft must not leave the identity-only
-- acknowledgement overload callable beside the generation-safe contract.
DROP FUNCTION IF EXISTS public.fn_ack_tournament_manager_wakes(uuid,bigint[]);
CREATE OR REPLACE FUNCTION public.fn_ack_tournament_manager_wakes(
  p_tournament_id uuid,
  p_wake_ids bigint[],
  p_wake_generations bigint[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_ids bigint[];
  v_found integer;
  v_changed integer;
  v_current_receipts jsonb;
BEGIN
  SELECT array_agg(DISTINCT id ORDER BY id)
    INTO v_ids
    FROM unnest(p_wake_ids) id
   WHERE id>0;
  IF p_tournament_id IS NULL OR v_ids IS NULL
     OR cardinality(v_ids)<>cardinality(p_wake_ids)
     OR p_wake_generations IS NULL
     OR cardinality(p_wake_generations)<>cardinality(p_wake_ids)
     OR EXISTS (
       SELECT 1 FROM unnest(p_wake_generations) generation
        WHERE generation IS NULL OR generation<=0
     )
     OR cardinality(v_ids)>200 THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_exact_wake_set');
  END IF;

  -- Lock and verify every exact id before acknowledging any. A global
  -- identity value says nothing about commit order, so no range predicate is
  -- permitted at this boundary.
  PERFORM 1
    FROM public.tournament_manager_wakes w
   WHERE w.id=ANY(v_ids)
   ORDER BY w.id
   FOR UPDATE;
  SELECT count(*) INTO v_found
    FROM public.tournament_manager_wakes w
   WHERE w.id=ANY(v_ids) AND w.tournament_id=p_tournament_id;
  IF v_found<>cardinality(v_ids) THEN
    RETURN jsonb_build_object('ok',false,'reason','wake_identity_or_tournament_mismatch');
  END IF;

  UPDATE public.tournament_manager_wakes w
     SET consumed_at=coalesce(w.consumed_at,clock_timestamp())
    FROM unnest(p_wake_ids,p_wake_generations) requested(id,generation)
   WHERE w.id=requested.id AND w.tournament_id=p_tournament_id
     AND w.generation=requested.generation AND w.consumed_at IS NULL;
  GET DIAGNOSTICS v_changed=ROW_COUNT;

  -- Return the post-lock generation of every exact identity. A signal that
  -- arrived while the manager's sweep was in flight increments generation and
  -- remains unconsumed; the manager must run that newer generation before it
  -- may delete the local receipt.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id',w.id,
           'generation',w.generation,
           'consumed',w.consumed_at IS NOT NULL
         ) ORDER BY w.id),'[]'::jsonb)
    INTO v_current_receipts
    FROM public.tournament_manager_wakes w
   WHERE w.id=ANY(v_ids) AND w.tournament_id=p_tournament_id;
  RETURN jsonb_build_object(
    'ok',true,
    'requested',cardinality(v_ids),
    'newly_acknowledged',v_changed,
    'current_receipts',v_current_receipts);
END;
$function$;

-- Every path that transitions an obligation to settled passes this one trigger.
-- The wake commits or rolls back with the settlement, so a lost HTTP response
-- and a lost Realtime frame still leave durable manager work to adopt.
CREATE OR REPLACE FUNCTION public.fn_emit_manager_wake_for_settled_bounty()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  IF OLD.state IS DISTINCT FROM 'settled' AND NEW.state='settled' THEN
    PERFORM public.fn_emit_tournament_manager_wake(NEW.tournament_id,'bounty_settled');
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_emit_manager_wake_for_settled_bounty
  ON public.tournament_bounty_obligations;
CREATE TRIGGER trg_emit_manager_wake_for_settled_bounty
AFTER UPDATE OF state ON public.tournament_bounty_obligations
FOR EACH ROW EXECUTE FUNCTION public.fn_emit_manager_wake_for_settled_bounty();

-- The vote and its durable manager wake are one browser-authorized database
-- transaction. Installing a trigger on the actively read/written vote table
-- would require ACCESS EXCLUSIVE during rollout; the RPC gives the operation
-- one authoritative door without pausing a live final table.
CREATE OR REPLACE FUNCTION public.fn_cast_tournament_deal_vote(
  p_tournament_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_inserted integer;
  v_wake_id bigint;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE='42501';
  END IF;
  PERFORM 1
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
     AND t.status='RUNNING'
     AND coalesce(t.final_table_deal_enabled,false)
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','deal_vote_not_open');
  END IF;
  PERFORM 1
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.user_id=v_user_id
     AND tp.status IN ('registered','playing')
     AND tp.eliminated_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','voter_not_alive');
  END IF;

  INSERT INTO public.tournament_deal_votes(tournament_id,user_id)
  VALUES (p_tournament_id,v_user_id)
  ON CONFLICT (tournament_id,user_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  -- Emit on exact replay too. This closes the rolling-deploy case where an old
  -- client inserted the vote directly but no durable wake accompanied it.
  v_wake_id := public.fn_emit_tournament_manager_wake(p_tournament_id,'deal_vote');
  RETURN jsonb_build_object(
    'ok',true,'voted',true,'already',v_inserted=0,'wake_id',v_wake_id);
END;
$function$;

-- Revoke SECURITY DEFINER defaults before the one transaction becomes visible.
REVOKE ALL ON FUNCTION public.fn_emit_tournament_manager_wake(uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_emit_tournament_manager_wake(uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ack_tournament_manager_wakes(uuid,bigint[],bigint[])
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ack_tournament_manager_wakes(uuid,bigint[],bigint[])
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_cast_tournament_deal_vote(uuid)
  FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.fn_cast_tournament_deal_vote(uuid)
  TO authenticated;

DO $do$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.tournament_manager_wakes;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$do$;

DO $do$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.tournament_bounty_obligations;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$do$;

DO $do$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.tournament_deal_votes;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$do$;

-- The compiled financial functions below become visible with the schema,
-- publications, grants, assertions, and trigger switch at the single COMMIT.
-- No generic receipt backfill is attempted here. A partial historical deal
-- cannot prove the complete participant set after some standings have already
-- been stamped. The production preflight for this rollout must assert zero
-- receipt-less COMPLETING final-table deals; any future ambiguous row remains
-- fail-closed in the recovery watchdog and requires an operator decision.

-- One indexed database statement replaces the old client-side walk of every
-- tournament table followed by one table_seats request per 200 ids. It keeps
-- the established duplicate-seat rule (only a unique newest joined_at owns
-- the stack), delegates ordered row locking to fn_sync_tournament_chips, and
-- returns just the user-id sets needed by the seatless-player backstop.
CREATE OR REPLACE FUNCTION public.fn_sync_tournament_live_seat_chips(
  p_tournament_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_updates jsonb;
  v_open_user_ids jsonb;
  v_ambiguous_user_ids jsonb;
  v_synced integer;
BEGIN
  WITH live AS (
    SELECT s.user_id,s.stack,s.joined_at
      FROM public.tables t
      JOIN public.table_seats s ON s.table_id=t.id AND s.left_at IS NULL
     WHERE t.tournament_id=p_tournament_id
  ), latest AS (
    SELECT user_id,max(joined_at) AS latest_joined_at FROM live GROUP BY user_id
  ), classified AS (
    SELECT l.user_id,m.latest_joined_at,
           count(*) FILTER (WHERE l.joined_at=m.latest_joined_at) AS latest_count,
           max(l.stack) FILTER (WHERE l.joined_at=m.latest_joined_at) AS latest_stack
      FROM live l JOIN latest m USING (user_id)
     GROUP BY l.user_id,m.latest_joined_at
  )
  SELECT COALESCE(jsonb_agg(DISTINCT user_id ORDER BY user_id),'[]'::jsonb),
         COALESCE(jsonb_agg(user_id ORDER BY user_id) FILTER (
           WHERE latest_joined_at IS NULL OR latest_count<>1),'[]'::jsonb),
         COALESCE(jsonb_agg(jsonb_build_object(
           'user_id',user_id,'chips',floor(GREATEST(COALESCE(latest_stack,0),0)))
           ORDER BY user_id) FILTER (
             WHERE latest_joined_at IS NOT NULL AND latest_count=1),'[]'::jsonb)
    INTO v_open_user_ids,v_ambiguous_user_ids,v_updates
    FROM classified;

  v_synced := public.fn_sync_tournament_chips(p_tournament_id,v_updates);
  RETURN jsonb_build_object('ok',true,'synced',COALESCE(v_synced,0),
    'open_user_ids',v_open_user_ids,'ambiguous_user_ids',v_ambiguous_user_ids);
END;
$function$;

-- A non-bounty place is also one accounting event. The old engine stamped
-- status/position/prize first and only then created the payable obligation;
-- a crash in that gap left a row that looked fully recorded but had never
-- moved money. This transaction couples the zero-stack CAS, exact place
-- obligation/payment and tournament-scoped seat release. A CAS race raises so
-- any credit performed earlier in this same call rolls back with it.
CREATE OR REPLACE FUNCTION public.fn_eliminate_tournament_player_atomic(
  p_tournament_id uuid,
  p_user_id uuid,
  p_position integer,
  p_prize numeric,
  p_bubble_refund numeric DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_p public.tournament_players%ROWTYPE;
  v_settle jsonb;
  v_place_obligation public.tournament_obligations%ROWTYPE;
  v_bubble_settle jsonb;
  v_bubble_obligation public.tournament_obligations%ROWTYPE;
  v_changed integer;
  v_released_tables uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_position < 2 OR p_prize IS NULL OR p_prize < 0
     OR p_bubble_refund IS NULL OR p_bubble_refund < 0 THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_place_or_prize');
  END IF;
  SELECT * INTO v_t FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;
  IF v_t.status <> 'RUNNING' THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_running');
  END IF;
  IF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
     OR COALESCE(v_t.is_mystery_bounty,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','bounty_requires_outbox_claim');
  END IF;
  SELECT * INTO v_p FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','player_not_found'); END IF;
  IF v_p.status = 'winner' THEN
    RETURN jsonb_build_object('ok',false,'reason','player_is_winner');
  END IF;
  IF v_p.status = 'eliminated' THEN
    IF v_p.position IS DISTINCT FROM p_position
       OR round(COALESCE(v_p.prize,0),2) <> round(p_prize,2) THEN
      RETURN jsonb_build_object('ok',false,'reason','elimination_identity_conflict');
    END IF;
    IF p_prize > 0 AND NOT EXISTS (
      SELECT 1 FROM public.tournament_obligations o
       WHERE o.tournament_id=p_tournament_id AND o.kind='place'
         AND o.place=p_position AND o.user_id=p_user_id
         AND round(o.amount_owed,2)=round(p_prize,2)
         AND round(o.amount_paid,2)=round(p_prize,2)
         AND o.settled_at IS NOT NULL
    ) THEN
      RETURN jsonb_build_object('ok',false,'reason','eliminated_place_not_paid');
    END IF;
    IF p_bubble_refund > 0 AND NOT EXISTS (
      SELECT 1 FROM public.tournament_obligations o
       WHERE o.tournament_id=p_tournament_id AND o.kind='bubble_protection'
         AND o.user_id=p_user_id AND o.place IS NULL
         AND round(o.amount_owed,2)=round(p_bubble_refund,2)
         AND round(o.amount_paid,2)=round(p_bubble_refund,2)
         AND o.settled_at IS NOT NULL
    ) THEN
      RETURN jsonb_build_object('ok',false,'reason','eliminated_bubble_not_paid');
    END IF;
    RETURN jsonb_build_object('ok',true,'already',true,'position',v_p.position,'prize',v_p.prize);
  END IF;
  IF v_p.status <> 'playing' OR COALESCE(v_p.chips,0) > 0 THEN
    RETURN jsonb_build_object('ok',false,'reason','not_busted');
  END IF;
  IF p_bubble_refund>0 AND (NOT COALESCE(v_t.bubble_protection,false) OR p_prize>0) THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_bubble_refund');
  END IF;

  IF p_prize > 0 THEN
    v_settle := public.fn_settle_tournament_obligation(
      p_tournament_id,'place',p_position,p_user_id,round(p_prize,2),
      'engine.eliminatePlayer',
      format('Tournament prize: position %s',p_position));
    IF NOT COALESCE((v_settle->>'ok')::boolean,false) THEN
      -- fn_settle_tournament_obligation may already have inserted or raised
      -- amount_owed on its durable obligation before discovering a refusal.
      -- A normal RETURN would commit that half-operation while leaving this
      -- player playing. Raise so the entire elimination transaction rewinds.
      RAISE EXCEPTION 'place payment refused: %',COALESCE(v_settle::text,'null')
        USING ERRCODE='check_violation';
    END IF;
    SELECT * INTO v_place_obligation
      FROM public.tournament_obligations o
     WHERE o.id=(v_settle->>'obligation_id')::uuid
       AND o.tournament_id=p_tournament_id AND o.kind='place'
       AND o.place=p_position AND o.user_id=p_user_id
     FOR UPDATE;
    IF NOT FOUND
       OR round(v_place_obligation.amount_owed,2) <> round(p_prize,2)
       OR round(v_place_obligation.amount_paid,2) <> round(p_prize,2)
       OR v_place_obligation.settled_at IS NULL THEN
      RAISE EXCEPTION 'place payment did not produce the exact durable receipt'
        USING ERRCODE='check_violation';
    END IF;
  END IF;

  IF p_bubble_refund > 0 THEN
    v_bubble_settle := public.fn_settle_tournament_obligation(
      p_tournament_id,'bubble_protection',NULL,p_user_id,round(p_bubble_refund,2),
      'engine.eliminatePlayer',
      format('Bubble protection: buy-in returned (bubbled at position %s)',p_position));
    IF NOT COALESCE((v_bubble_settle->>'ok')::boolean,false) THEN
      RAISE EXCEPTION 'bubble protection payment refused: %',COALESCE(v_bubble_settle::text,'null')
        USING ERRCODE='check_violation';
    END IF;
    SELECT * INTO v_bubble_obligation
      FROM public.tournament_obligations o
     WHERE o.id=(v_bubble_settle->>'obligation_id')::uuid
       AND o.tournament_id=p_tournament_id AND o.kind='bubble_protection'
       AND o.place IS NULL AND o.user_id=p_user_id
     FOR UPDATE;
    IF NOT FOUND
       OR round(v_bubble_obligation.amount_owed,2)<>round(p_bubble_refund,2)
       OR round(v_bubble_obligation.amount_paid,2)<>round(p_bubble_refund,2)
       OR v_bubble_obligation.settled_at IS NULL THEN
      RAISE EXCEPTION 'bubble protection did not produce the exact durable receipt'
        USING ERRCODE='check_violation';
    END IF;
  END IF;

  UPDATE public.tournament_players
     SET status='eliminated',position=p_position,prize=round(p_prize,2),eliminated_at=now()
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     AND status='playing' AND COALESCE(chips,0)<=0;
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed <> 1 THEN
    RAISE EXCEPTION 'zero-stack elimination CAS changed % rows',v_changed
      USING ERRCODE='serialization_failure';
  END IF;

  WITH released AS (
    UPDATE public.table_seats s SET left_at=now()
      FROM public.tables tb
     WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id
       AND s.user_id=p_user_id AND s.left_at IS NULL
    RETURNING s.table_id
  ) SELECT COALESCE(array_agg(DISTINCT table_id),ARRAY[]::uuid[])
      INTO v_released_tables FROM released;
  UPDATE public.tables tb SET current_players=(
    SELECT count(*) FROM public.table_seats s WHERE s.table_id=tb.id AND s.left_at IS NULL)
   WHERE tb.id=ANY(v_released_tables);
  PERFORM public.fn_sync_seat_first_player_count(p_tournament_id);

  RETURN jsonb_build_object('ok',true,'claimed',true,'position',p_position,
                            'prize',round(p_prize,2),'settlement',v_settle,
                            'bubble_refund',round(p_bubble_refund,2),
                            'bubble_settlement',v_bubble_settle);
END;
$function$;

COMMENT ON TABLE public.tournament_bounty_obligations IS
  'Atomic knockout-to-bounty outbox. Created in the same transaction as the playing/chips<=0 elimination CAS and settled by the payout-ledger transaction.';

-- Canonical ownership comes from the exact modern hand, never from caller
-- order and never from the largest side-pot winner.  A missing pots ledger on
-- a globally numbered hand is corruption/incomplete persistence, so NULL is a
-- retryable refusal rather than a guess.
CREATE OR REPLACE FUNCTION public.fn_exact_tournament_knockout_claimants(
  p_tournament_id uuid,
  p_hand_id uuid,
  p_eliminated_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pots jsonb;
  v_winners jsonb;
  v_last_pot integer;
  v_winning_pot integer;
  v_chosen_pot_count integer;
  v_raw_winner_count integer;
  v_valid_winner_count integer;
  v_distinct_winner_count integer;
  v_chosen_eligible jsonb;
  v_claimants jsonb;
BEGIN
  SELECT h.pots, h.winners INTO v_pots, v_winners
    FROM public.hand_history h
   WHERE h.id = p_hand_id;
  IF jsonb_typeof(v_pots) <> 'array' OR jsonb_array_length(v_pots) = 0
     OR jsonb_typeof(v_winners) <> 'array' OR jsonb_array_length(v_winners) = 0 THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_winners) w
     WHERE COALESCE(w->>'potIndex',w->>'pot_index','') !~ '^[0-9]+$'
  ) THEN
    RETURN NULL;
  END IF;

  WITH pots AS (
    SELECT CASE WHEN COALESCE(p->>'index','') ~ '^[0-9]+$'
                THEN (p->>'index')::integer ELSE ordinality::integer - 1 END AS pot_index,
           COALESCE(p->'eligible', p->'eligiblePlayers', '[]'::jsonb) AS eligible
      FROM jsonb_array_elements(v_pots) WITH ORDINALITY AS q(p, ordinality)
  )
  SELECT max(pot_index) INTO v_last_pot
    FROM pots
   WHERE jsonb_typeof(eligible) = 'array'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(eligible) e(user_id)
                  WHERE e.user_id = p_eliminated_user_id::text);
  IF v_last_pot IS NULL THEN RETURN NULL; END IF;

  -- A modern row that cannot name a valid winner of the exact last pot is
  -- incomplete. Do not walk down to a different pot or largest winner: that
  -- would assign money to somebody who did not own the knockout.
  v_winning_pot := v_last_pot;

  SELECT count(*)
    INTO v_chosen_pot_count
    FROM jsonb_array_elements(v_pots) WITH ORDINALITY AS q(p,ordinality)
   WHERE CASE WHEN COALESCE(p->>'index','') ~ '^[0-9]+$'
              THEN (p->>'index')::integer ELSE ordinality::integer-1 END=v_winning_pot;
  IF v_chosen_pot_count<>1 THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(p->'eligible',p->'eligiblePlayers','[]'::jsonb)
    INTO v_chosen_eligible
    FROM jsonb_array_elements(v_pots) WITH ORDINALITY AS q(p,ordinality)
   WHERE CASE WHEN COALESCE(p->>'index','') ~ '^[0-9]+$'
              THEN (p->>'index')::integer ELSE ordinality::integer-1 END=v_winning_pot;
  IF jsonb_typeof(v_chosen_eligible)<>'array' THEN RETURN NULL; END IF;

  -- Never canonicalise corruption by filtering it away. Every winner row for
  -- the exact pot must name one distinct tournament participant who is in the
  -- pot's eligible set. A malformed outsider in a tie makes the whole money
  -- authority unavailable; it does not enlarge the valid player's share.
  WITH exact_winners AS (
    SELECT w,COALESCE(w->>'userId',w->>'user_id','') AS user_id_text
      FROM jsonb_array_elements(v_winners) w
     WHERE COALESCE(w->>'potIndex',w->>'pot_index')::integer=v_winning_pot
  ), classified AS (
    SELECT user_id_text,
           user_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             AND user_id_text<>p_eliminated_user_id::text
             AND EXISTS (SELECT 1 FROM public.tournament_players tp
                          WHERE tp.tournament_id=p_tournament_id
                            AND tp.user_id=CASE
                              WHEN user_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                              THEN user_id_text::uuid ELSE NULL END)
             AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_chosen_eligible) e(user_id)
                          WHERE e.user_id=user_id_text) AS valid
      FROM exact_winners
  )
  SELECT count(*),count(*) FILTER (WHERE valid),
         count(DISTINCT user_id_text) FILTER (WHERE valid)
    INTO v_raw_winner_count,v_valid_winner_count,v_distinct_winner_count
    FROM classified;
  -- Hi-lo histories legitimately contain one row for the high half and one
  -- for the low half when the same player scoops. Validate every source row,
  -- then canonicalise to distinct claimant ids below; duplicate winner rows
  -- are not duplicate people and must not invalidate an otherwise exact pot.
  IF v_raw_winner_count=0 OR v_valid_winner_count<>v_raw_winner_count
     OR v_distinct_winner_count=0 THEN
    RETURN NULL;
  END IF;

  WITH participants AS (
    SELECT DISTINCT COALESCE(w->>'userId',w->>'user_id')::uuid AS user_id
      FROM jsonb_array_elements(v_winners) w
     WHERE COALESCE(w->>'potIndex',w->>'pot_index')::integer=v_winning_pot
  )
  SELECT jsonb_agg(jsonb_build_object('user_id', user_id, 'weight', 1)
                   ORDER BY user_id::text)
    INTO v_claimants FROM participants;
  RETURN v_claimants;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_claim_tournament_bounty_elimination(
  p_tournament_id uuid,
  p_eliminated_user_id uuid,
  p_position integer,
  p_prize numeric,
  p_table_id uuid,
  p_hand_id uuid,
  p_hand_number bigint,
  p_seat_joined_at timestamptz,
  p_knocker_user_id uuid,
  p_claimants jsonb,
  p_bubble_refund numeric DEFAULT 0,
  p_allow_existing_eliminated boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_player public.tournament_players%ROWTYPE;
  v_settlement_at timestamptz;
  v_mode text;
  v_claimants jsonb;
  v_input_claimants jsonb;
  v_knocker uuid;
  v_head numeric;
  v_hand_created_at timestamptz;
  v_latest_joined_at timestamptz;
  v_position integer;
  v_prize numeric;
  v_place_settle jsonb;
  v_place_obligation public.tournament_obligations%ROWTYPE;
  v_bubble_settle jsonb;
  v_bubble_obligation public.tournament_obligations%ROWTYPE;
  v_claimed boolean := false;
  v_existing public.tournament_bounty_obligations%ROWTYPE;
  v_activation_generation bigint := 0;
  v_pko_watermark bigint;
BEGIN
  IF p_tournament_id IS NULL OR p_eliminated_user_id IS NULL OR p_table_id IS NULL
     OR p_hand_id IS NULL OR p_hand_number IS NULL OR p_hand_number < 1000000
     OR p_seat_joined_at IS NULL OR p_bubble_refund IS NULL OR p_bubble_refund<0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_identity');
  END IF;

  IF p_claimants IS NOT NULL THEN
    IF jsonb_typeof(p_claimants) <> 'array' OR jsonb_array_length(p_claimants)=0
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_claimants) e
          WHERE COALESCE(e->>'user_id','')
                  !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             OR COALESCE(e->>'weight','') !~ '^[0-9]+([.][0-9]+)?$'
             OR (e->>'weight')::numeric <= 0
       ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_claimants');
    END IF;
    SELECT jsonb_agg(jsonb_build_object('user_id', user_id, 'weight', 1)
                     ORDER BY user_id::text)
      INTO v_input_claimants
      FROM (SELECT DISTINCT (e->>'user_id')::uuid AS user_id
              FROM jsonb_array_elements(p_claimants) e) q;
  END IF;

  SELECT * INTO v_t FROM public.tournaments
   WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;

  -- The obligation is the accepted claim receipt.  Check it before today's
  -- player status, latest seat or mystery phase: those mutable facts can all
  -- change after a successful call whose response was lost.
  SELECT * INTO v_existing FROM public.tournament_bounty_obligations
   WHERE tournament_id=p_tournament_id
     AND eliminated_user_id=p_eliminated_user_id
     AND seat_joined_at=p_seat_joined_at
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.table_id<>p_table_id OR v_existing.hand_id<>p_hand_id
       OR v_existing.hand_number<>p_hand_number
       OR v_existing.bubble_refund<>round(p_bubble_refund,2)
       OR v_existing.position IS DISTINCT FROM p_position
       OR v_existing.prize IS DISTINCT FROM round(p_prize,2)
       OR (p_knocker_user_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(v_existing.claimants) c
              WHERE c->>'user_id'=p_knocker_user_id::text))
       OR (v_input_claimants IS NOT NULL
           AND v_existing.claimants IS DISTINCT FROM v_input_claimants) THEN
      RETURN jsonb_build_object('ok',false,'reason','obligation_identity_conflict');
    END IF;
    IF v_existing.state='settled'
       AND NOT public.fn_bounty_obligation_has_complete_marker(v_existing.id) THEN
      RETURN jsonb_build_object('ok',false,'reason','settled_marker_incomplete',
                                'obligation_id',v_existing.id);
    END IF;
    RETURN jsonb_build_object('ok',true,'already',true,'claimed',false,
      'mode',v_existing.mode,'state',v_existing.state,
      'activation_generation',v_existing.activation_generation,
      'obligation_id',v_existing.id);
  END IF;

  IF NOT (COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
          OR COALESCE(v_t.is_mystery_bounty, false)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_bounty_tournament');
  END IF;

  -- The finalisation owner may finish an already-observed live knockout while
  -- COMPLETING. The compatibility argument does not authorize reconstruction
  -- of an eliminated row or mutation of an already-COMPLETED tournament.
  IF upper(COALESCE(v_t.status,'')) <> 'RUNNING'
     AND NOT (p_allow_existing_eliminated
              AND upper(COALESCE(v_t.status,'')) = 'COMPLETING') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_lifecycle_not_claimable',
                              'status', v_t.status);
  END IF;

  SELECT * INTO v_player FROM public.tournament_players
   WHERE tournament_id = p_tournament_id AND user_id = p_eliminated_user_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'player_not_found'); END IF;
  IF COALESCE(v_player.chips, 0) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'player_has_chips');
  END IF;
  IF v_player.status <> 'playing' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'status_not_claimable', 'status', v_player.status);
  END IF;
  IF p_position IS NULL OR p_position < 2 OR p_prize IS NULL OR p_prize < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_place_or_prize');
  END IF;
  v_position := p_position;
  v_prize := p_prize;
  IF p_bubble_refund>0 AND (NOT COALESCE(v_t.bubble_protection,false) OR v_prize>0) THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_bubble_refund');
  END IF;
  -- The seat generation closes the rebuy/re-bust ambiguity. An old zero hand
  -- from the same physical table cannot authorize a newer seat.
  IF NOT EXISTS (
    SELECT 1 FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
    WHERE s.user_id = p_eliminated_user_id
      AND s.table_id = p_table_id
      AND tb.tournament_id = p_tournament_id
      AND s.joined_at = p_seat_joined_at
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_generation_not_found');
  END IF;

  SELECT max(s.joined_at) INTO v_latest_joined_at
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_eliminated_user_id;
  IF v_latest_joined_at IS DISTINCT FROM p_seat_joined_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_generation_not_current');
  END IF;

  SELECT k.completed_at INTO v_settlement_at
    FROM public.settlement_idempotency_keys k
   WHERE k.table_id = p_table_id
     AND k.status = 'succeeded'
     AND k.completed_at >= p_seat_joined_at
     AND COALESCE(k.result->>'hand_number', '') ~ '^[0-9]+$'
     AND (k.result->>'hand_number')::bigint = p_hand_number
     AND k.result->>'table_id' = p_table_id::text
     AND k.result->'written' ? p_eliminated_user_id::text
     AND COALESCE(k.result->'written'->>p_eliminated_user_id::text, '') ~ '^-?[0-9]+([.][0-9]+)?$'
     AND (k.result->'written'->>p_eliminated_user_id::text)::numeric <= 0
   ORDER BY k.completed_at DESC
   LIMIT 1;
  IF v_settlement_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'accepted_zero_settlement_not_found');
  END IF;

  SELECT h.created_at INTO v_hand_created_at
    FROM public.hand_history h
   WHERE h.id = p_hand_id
     AND h.table_id = p_table_id
     AND h.hand_number = p_hand_number
     AND h.hand_number >= 1000000
     AND h.created_at >= v_settlement_at
     AND h.created_at >= p_seat_joined_at
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(h.players, '[]'::jsonb)) player
        WHERE COALESCE(player->>'userId', player->>'user_id') = p_eliminated_user_id::text
          AND COALESCE(player->>'stack', '') ~ '^-?[0-9]+([.][0-9]+)?$'
          AND (player->>'stack')::numeric <= 0
     );
  IF v_hand_created_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'exact_knockout_history_not_found');
  END IF;

  v_claimants := public.fn_exact_tournament_knockout_claimants(
    p_tournament_id, p_hand_id, p_eliminated_user_id);
  IF v_claimants IS NULL OR jsonb_array_length(v_claimants)=0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'exact_pot_claimants_not_found');
  END IF;

  SELECT (e->>'user_id')::uuid
  INTO v_knocker
  FROM jsonb_array_elements(v_claimants) e
  ORDER BY e->>'user_id'
  LIMIT 1;
  IF p_knocker_user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_claimants) e
                      WHERE e->>'user_id'=p_knocker_user_id::text) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_knocker');
  END IF;

  IF p_claimants IS NOT NULL THEN
    IF v_input_claimants IS DISTINCT FROM v_claimants THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'claimants_do_not_match_exact_pot');
    END IF;
  END IF;

  -- The locked live tournament phase is the authority for a new obligation.
  -- No prior award or mutable post-hoc row can be adopted into the outbox.
  v_mode := CASE
    WHEN COALESCE(v_t.is_mystery_bounty, false)
      AND v_t.mystery_bounty_stage = 'active' THEN 'mystery_chest'
    WHEN COALESCE(v_t.is_pko, false) THEN 'pko'
    WHEN COALESCE(v_t.is_mystery_bounty, false) THEN 'mystery_pre'
    ELSE 'regular'
  END;
  v_activation_generation := CASE WHEN v_mode='mystery_chest'
    THEN v_t.mystery_bounty_activation_generation ELSE 0 END;
  IF v_mode='mystery_chest' AND (v_activation_generation<=0 OR NOT EXISTS (
    SELECT 1 FROM public.tournament_mystery_activation_receipts ar
     WHERE ar.tournament_id=p_tournament_id
       AND ar.activation_generation=v_activation_generation
  )) THEN
    RETURN jsonb_build_object('ok',false,'reason','mystery_activation_evidence_missing');
  END IF;

  IF v_mode='pko' THEN
    SELECT w.last_settled_hand_number INTO v_pko_watermark
      FROM public.tournament_pko_settlement_watermarks w
     WHERE w.tournament_id=p_tournament_id
     FOR UPDATE;
    IF v_pko_watermark IS NOT NULL AND p_hand_number<v_pko_watermark THEN
      RETURN jsonb_build_object('ok',false,'reason','pko_order_already_advanced',
                                'last_settled_hand_number',v_pko_watermark);
    END IF;
  END IF;

  -- A pending earlier PKO can still add half its head to this player. Claiming
  -- the player's later bust first would snapshot/zero the smaller head and
  -- strand the predecessor credit. Strict hand order makes that impossible.
  IF v_mode='pko' AND EXISTS (
    SELECT 1 FROM public.tournament_bounty_obligations prior
     WHERE prior.tournament_id=p_tournament_id AND prior.mode='pko' AND prior.state='pending'
       AND (prior.hand_number < p_hand_number
            OR (prior.hand_number=p_hand_number
                AND prior.eliminated_user_id::text < p_eliminated_user_id::text))
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(prior.claimants) c
                    WHERE c->>'user_id'=p_eliminated_user_id::text)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pending_pko_predecessor');
  END IF;

  -- Same-hand chain: if another zero-stack player in this exact hand awards
  -- head value to the player being claimed, that predecessor must be fully
  -- settled first even when no outbox for it has been created yet. This is a
  -- causal/topological dependency, not an arbitrary UUID ordering.
  IF v_mode='pko' AND EXISTS (
    SELECT 1
      FROM public.hand_history h
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(h.players,'[]'::jsonb)) hp
     WHERE h.id=p_hand_id
       AND COALESCE(hp->>'userId',hp->>'user_id','')
             ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND COALESCE(hp->>'userId',hp->>'user_id') <> p_eliminated_user_id::text
       AND COALESCE(hp->>'stack','') ~ '^-?[0-9]+([.][0-9]+)?$'
       AND (hp->>'stack')::numeric <= 0
       AND public.fn_exact_tournament_knockout_claimants(
             p_tournament_id,h.id,COALESCE(hp->>'userId',hp->>'user_id')::uuid)
             @> jsonb_build_array(jsonb_build_object(
                   'user_id',p_eliminated_user_id,'weight',1))
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_obligations predecessor
          WHERE predecessor.tournament_id=p_tournament_id
            AND predecessor.hand_number=p_hand_number
            AND predecessor.eliminated_user_id=
                COALESCE(hp->>'userId',hp->>'user_id')::uuid
            AND predecessor.state='settled'
       )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'same_hand_pko_predecessor');
  END IF;

  v_head := COALESCE(NULLIF(v_player.current_bounty,0),
                     NULLIF(v_t.bounty_amount,0));
  IF COALESCE(v_head,0) <= 0 THEN
    RETURN jsonb_build_object('ok',false,'reason','exact_head_value_not_found');
  END IF;

  IF v_prize > 0 THEN
      v_place_settle := public.fn_settle_tournament_obligation(
        p_tournament_id,'place',v_position,p_eliminated_user_id,round(v_prize,2),
        'engine.eliminatePlayer',
        format('Tournament prize: position %s',v_position));
      IF NOT COALESCE((v_place_settle->>'ok')::boolean,false) THEN
        RAISE EXCEPTION 'bounty elimination place payment refused: %',
          COALESCE(v_place_settle::text,'null') USING ERRCODE='check_violation';
      END IF;
      SELECT * INTO v_place_obligation
        FROM public.tournament_obligations o
       WHERE o.id=(v_place_settle->>'obligation_id')::uuid
         AND o.tournament_id=p_tournament_id AND o.kind='place'
         AND o.place=v_position AND o.user_id=p_eliminated_user_id
       FOR UPDATE;
      IF NOT FOUND
         OR round(v_place_obligation.amount_owed,2) <> round(v_prize,2)
         OR round(v_place_obligation.amount_paid,2) <> round(v_prize,2)
         OR v_place_obligation.settled_at IS NULL THEN
        RAISE EXCEPTION 'bounty elimination place payment did not produce the exact durable receipt'
          USING ERRCODE='check_violation';
      END IF;
  END IF;
  IF p_bubble_refund>0 THEN
      v_bubble_settle := public.fn_settle_tournament_obligation(
        p_tournament_id,'bubble_protection',NULL,p_eliminated_user_id,
        round(p_bubble_refund,2),'engine.eliminatePlayer',
        format('Bubble protection: buy-in returned (bubbled at position %s)',v_position));
      IF NOT COALESCE((v_bubble_settle->>'ok')::boolean,false) THEN
        RAISE EXCEPTION 'bounty bubble protection payment refused: %',
          COALESCE(v_bubble_settle::text,'null') USING ERRCODE='check_violation';
      END IF;
      SELECT * INTO v_bubble_obligation
        FROM public.tournament_obligations o
       WHERE o.id=(v_bubble_settle->>'obligation_id')::uuid
         AND o.tournament_id=p_tournament_id AND o.kind='bubble_protection'
         AND o.place IS NULL AND o.user_id=p_eliminated_user_id
       FOR UPDATE;
      IF NOT FOUND
         OR round(v_bubble_obligation.amount_owed,2)<>round(p_bubble_refund,2)
         OR round(v_bubble_obligation.amount_paid,2)<>round(p_bubble_refund,2)
         OR v_bubble_obligation.settled_at IS NULL THEN
        RAISE EXCEPTION 'bounty bubble protection did not produce the exact durable receipt'
          USING ERRCODE='check_violation';
      END IF;
  END IF;
  UPDATE public.tournament_players
     SET status = 'eliminated', position = p_position, prize = p_prize,
         eliminated_at = now()
   WHERE tournament_id = p_tournament_id
     AND user_id = p_eliminated_user_id
     AND status = 'playing' AND chips <= 0;
  IF NOT FOUND THEN
    -- A paid place and the bounty/status claim are one transaction. A CAS
    -- miss after settlement must undo the credit rather than commit a paid
    -- place beside a still-playing row.
    RAISE EXCEPTION 'bounty elimination CAS missed after locked settlement'
      USING ERRCODE='serialization_failure';
  END IF;
  v_claimed := true;

  INSERT INTO public.tournament_bounty_obligations
    (tournament_id, eliminated_user_id, table_id, hand_id, hand_number,
     settlement_completed_at, seat_joined_at, position, prize, bubble_refund,
     mode, activation_generation, head_amount, knocker_user_id, claimants,
     next_attempt_at)
  VALUES
    (p_tournament_id, p_eliminated_user_id, p_table_id, p_hand_id, p_hand_number,
     v_settlement_at, p_seat_joined_at, v_position, round(v_prize,2),round(p_bubble_refund,2),
     v_mode,v_activation_generation,round(v_head,2),v_knocker,v_claimants,
     CASE WHEN v_mode = 'mystery_chest' THEN now() + interval '30 seconds' ELSE now() END);

  -- Seat ownership is part of the same commit. A committed claim whose HTTP
  -- response is lost cannot leave a ghost at the felt after process death.
  UPDATE public.table_seats
     SET left_at=COALESCE(left_at,now())
   WHERE table_id=p_table_id AND user_id=p_eliminated_user_id
     AND joined_at=p_seat_joined_at AND left_at IS NULL;
  UPDATE public.tables
     SET current_players=(SELECT count(*) FROM public.table_seats s
                           WHERE s.table_id=p_table_id AND s.left_at IS NULL)
   WHERE id=p_table_id;
  PERFORM public.fn_sync_seat_first_player_count(p_tournament_id);

  UPDATE public.tournament_bounty_obligations o
     SET state='settled', settled_at=now()
   WHERE o.tournament_id=p_tournament_id AND o.eliminated_user_id=p_eliminated_user_id
     AND o.seat_joined_at=p_seat_joined_at
     AND public.fn_bounty_obligation_has_complete_marker(o.id);

  RETURN jsonb_build_object('ok', true, 'already', false, 'claimed', v_claimed,
    'mode', v_mode, 'state',(SELECT state FROM public.tournament_bounty_obligations o
      WHERE o.tournament_id=p_tournament_id AND o.eliminated_user_id=p_eliminated_user_id
        AND o.seat_joined_at=p_seat_joined_at),
    'activation_generation',v_activation_generation,
    'place_settlement',v_place_settle,
    'bubble_refund',round(p_bubble_refund,2),'bubble_settlement',v_bubble_settle,
    'obligation_id',(SELECT id FROM public.tournament_bounty_obligations o
      WHERE o.tournament_id=p_tournament_id AND o.eliminated_user_id=p_eliminated_user_id
        AND o.seat_joined_at=p_seat_joined_at));
END;
$function$;

-- A transport response is never payout evidence.  For a fixed/PKO knockout,
-- every canonical claimant must have exactly one generation-bound ledger row
-- and those rows must conserve the full snapshotted head.  For a mystery
-- knockout, the award itself must have reached its durable completed state.
CREATE OR REPLACE FUNCTION public.fn_bounty_obligation_has_complete_marker(p_obligation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE((
    SELECT CASE WHEN o.mode='mystery_chest' THEN
      EXISTS (
        SELECT 1 FROM public.tournament_bounty_awards a
         WHERE a.bounty_obligation_id=o.id AND a.status='completed'
           AND (SELECT COALESCE(sum(r.amount_cents),0)
                  FROM public.tournament_bounty_award_recipients r
                 WHERE r.award_id=a.id AND r.paid_at IS NOT NULL)=a.amount_cents
           AND NOT EXISTS (
             SELECT 1
               FROM (
                 SELECT claimant_id,ordinal,claimant_count,
                        floor(a.amount_cents / claimant_count)
                          + CASE WHEN ordinal <= mod(a.amount_cents,claimant_count)
                                 THEN 1 ELSE 0 END AS expected_cents
                   FROM (
                     SELECT (c->>'user_id')::uuid AS claimant_id,
                            row_number() OVER (ORDER BY c->>'user_id') AS ordinal,
                            count(*) OVER () AS claimant_count
                       FROM jsonb_array_elements(o.claimants) c
                   ) ordered_claimants
               ) expected
              WHERE NOT EXISTS (
                SELECT 1 FROM public.tournament_bounty_award_recipients r
                 WHERE r.award_id=a.id AND r.user_id=expected.claimant_id
                   AND r.amount_cents=expected.expected_cents
                   AND r.paid_at IS NOT NULL
              )
           )
           AND NOT EXISTS (
             SELECT 1 FROM public.tournament_bounty_award_recipients r
              WHERE r.award_id=a.id
                AND (r.paid_at IS NULL OR NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements(o.claimants) c
                   WHERE (c->>'user_id')::uuid=r.user_id
                ))
           )
      )
    ELSE
      NOT EXISTS (
        SELECT 1
          FROM (
            SELECT claimant_id, ordinal, claimant_count,
                   CASE WHEN ordinal < claimant_count
                        THEN floor(head_cents / claimant_count)
                        ELSE head_cents
                             - floor(head_cents / claimant_count) * (claimant_count - 1)
                   END AS expected_cents
              FROM (
                SELECT (c->>'user_id')::uuid AS claimant_id,
                       row_number() OVER (ORDER BY c->>'user_id') AS ordinal,
                       count(*) OVER () AS claimant_count,
                       round(o.head_amount * 100)::bigint AS head_cents
                  FROM jsonb_array_elements(o.claimants) c
              ) ordered_claimants
          ) expected
         WHERE expected.expected_cents > 0
           AND NOT EXISTS (
           SELECT 1 FROM public.tournament_bounties b
            WHERE b.bounty_obligation_id=o.id
              AND b.collector_player_id=expected.claimant_id
              AND round(b.bounty_amount * 100)::bigint=expected.expected_cents
              AND round(COALESCE(b.added_to_collector_bounty,0) * 100)::bigint=
                    CASE WHEN o.mode='pko'
                         THEN expected.expected_cents-floor(expected.expected_cents/2.0)::bigint
                         ELSE 0 END
              AND round((b.bounty_amount-COALESCE(b.added_to_collector_bounty,0))*100)::bigint=
                    CASE WHEN o.mode='pko'
                         THEN floor(expected.expected_cents/2.0)::bigint
                         ELSE expected.expected_cents END
         )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.tournament_bounties b
         WHERE b.bounty_obligation_id=o.id
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(o.claimants) c
              WHERE (c->>'user_id')::uuid=b.collector_player_id
           )
      )
      AND round(COALESCE((
        SELECT sum(b.bounty_amount) FROM public.tournament_bounties b
         WHERE b.bounty_obligation_id=o.id
      ),0),2)=round(o.head_amount,2)
    END
      FROM public.tournament_bounty_obligations o
     WHERE o.id=p_obligation_id
  ),false);
$function$;

-- Existing payer signatures stay DB-first compatible.  These BEFORE triggers
-- attach their legacy-shaped inserts to the one locked pending generation.
CREATE OR REPLACE FUNCTION public.fn_attach_bounty_ledger_obligation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_context text := current_setting('app.bounty_obligation_id',true);
  v_obligation_id uuid;
BEGIN
  IF NEW.bounty_obligation_id IS NULL THEN
    IF COALESCE(v_context,'')
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      v_obligation_id := v_context::uuid;
      SELECT o.id INTO NEW.bounty_obligation_id
        FROM public.tournament_bounty_obligations o
       WHERE o.id=v_obligation_id AND o.tournament_id=NEW.tournament_id
         AND o.eliminated_user_id=NEW.eliminated_player_id
         AND o.mode<>'mystery_chest';
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
       AND o.mode<>'mystery_chest'
  ) THEN
    RAISE EXCEPTION 'bounty ledger names a mismatched obligation generation'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_attach_bounty_award_obligation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_context text := current_setting('app.bounty_obligation_id',true);
  v_obligation_id uuid;
  v_activation_generation bigint;
BEGIN
  IF NEW.bounty_obligation_id IS NULL THEN
    IF COALESCE(v_context,'')
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      v_obligation_id := v_context::uuid;
      SELECT o.id,o.activation_generation
        INTO NEW.bounty_obligation_id,v_activation_generation
        FROM public.tournament_bounty_obligations o
       WHERE o.id=v_obligation_id AND o.tournament_id=NEW.tournament_id
         AND o.eliminated_user_id=NEW.eliminated_user_id
         AND o.mode='mystery_chest' AND o.hand_id::text=NEW.hand_id;
      IF NEW.bounty_obligation_id IS NULL THEN
        RAISE EXCEPTION 'mystery award context does not match its exact generation'
          USING ERRCODE='check_violation';
      END IF;
      NEW.activation_generation := v_activation_generation;
    ELSIF EXISTS (
      SELECT 1 FROM public.tournament_bounty_obligations o
       WHERE o.tournament_id=NEW.tournament_id
         AND o.eliminated_user_id=NEW.eliminated_user_id
         AND o.mode='mystery_chest' AND o.hand_id::text=NEW.hand_id
    ) THEN
      RAISE EXCEPTION 'generation-bound mystery award has no exact obligation context'
        USING ERRCODE='check_violation';
    END IF;
  ELSE
    SELECT o.activation_generation INTO v_activation_generation
      FROM public.tournament_bounty_obligations o
     WHERE o.id=NEW.bounty_obligation_id AND o.tournament_id=NEW.tournament_id
       AND o.eliminated_user_id=NEW.eliminated_user_id
       AND o.mode='mystery_chest' AND o.hand_id::text=NEW.hand_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mystery award names a mismatched obligation generation'
        USING ERRCODE='check_violation';
    END IF;
    NEW.activation_generation := v_activation_generation;
  END IF;
  RETURN NEW;
END;
$function$;

-- A payout marker settles its outbox row in the SAME database transaction.
-- If the transaction rolls back, so does this acknowledgement; if only the
-- HTTP response is lost, the durable state already says settled.
CREATE OR REPLACE FUNCTION public.fn_ack_bounty_obligation_from_ledger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.tournament_bounty_obligations o
     SET state = 'settled', settled_at = COALESCE(settled_at, now()), last_error = NULL
   WHERE o.id=NEW.bounty_obligation_id AND o.mode <> 'mystery_chest' AND o.state='pending'
     AND public.fn_bounty_obligation_has_complete_marker(o.id);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ack_bounty_obligation_from_award()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'completed' THEN
    UPDATE public.tournament_bounty_obligations
       SET state = 'settled', settled_at = COALESCE(settled_at, now()), last_error = NULL
     WHERE id=NEW.bounty_obligation_id
       AND mode = 'mystery_chest' AND state = 'pending'
       AND public.fn_bounty_obligation_has_complete_marker(id);
  END IF;
  RETURN NEW;
END;
$function$;

-- Re-entry is a new paid head, but it cannot begin while the prior head is
-- still owed: the legacy payer reads current_bounty and would otherwise pay
-- or zero the new generation. Once the durable marker settles the outbox,
-- the normal re-entry RPC may reset the head and create a distinct generation.
CREATE OR REPLACE FUNCTION public.fn_refuse_reentry_with_pending_bounty()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  IF OLD.status='eliminated' AND NEW.status='playing'
     AND EXISTS (SELECT 1 FROM public.tournament_bounty_obligations o
                  WHERE o.tournament_id=NEW.tournament_id
                    AND o.eliminated_user_id=NEW.user_id AND o.state='pending') THEN
    RAISE EXCEPTION 'prior bounty obligation is still pending for tournament %, player %',
      NEW.tournament_id, NEW.user_id USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

-- Keep the established, heavily-audited payout arithmetic, but upgrade its
-- idempotency boundary from tournament+user to the pending seat generation.
-- Asserted substitutions abort the migration if the live definition drifted;
-- silently patching a different money function is not acceptable.
DO $do$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  -- A successful earlier pass already preserved the patched bodies under the
  -- private names below. Do not try to patch the public wrappers on a rerun.
  IF to_regprocedure('public.fn_collect_bounty_unguarded_20260907(uuid,uuid,uuid,jsonb)') IS NOT NULL
     AND to_regprocedure('public.fn_mystery_bounty_reserve_unguarded_20260907(uuid,uuid,jsonb,uuid,text,uuid,integer)') IS NOT NULL
     AND to_regprocedure('public.fn_mystery_bounty_pay_unguarded_20260907(uuid)') IS NOT NULL THEN
    RETURN;
  END IF;
  IF to_regprocedure('public.fn_collect_bounty_unguarded_20260907(uuid,uuid,uuid,jsonb)') IS NOT NULL
     OR to_regprocedure('public.fn_mystery_bounty_reserve_unguarded_20260907(uuid,uuid,jsonb,uuid,text,uuid,integer)') IS NOT NULL
     OR to_regprocedure('public.fn_mystery_bounty_pay_unguarded_20260907(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'partial bounty payer wrapper state; refusing to patch a public wrapper';
  END IF;

  SELECT pg_get_functiondef('public.fn_collect_bounty(uuid,uuid,uuid,jsonb)'::regprocedure)
    INTO v_def;
  v_old := $old$IF EXISTS (SELECT 1 FROM tournament_bounties
              WHERE tournament_id = p_tournament_id
                AND eliminated_player_id = p_eliminated_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_collected');
  END IF;$old$;
  v_new := $new$IF EXISTS (
    SELECT 1 FROM tournament_bounties b
     WHERE b.tournament_id = p_tournament_id
       AND b.eliminated_player_id = p_eliminated_user_id
       AND (
         b.bounty_obligation_id = (SELECT o.id
           FROM tournament_bounty_obligations o
          WHERE o.tournament_id=p_tournament_id
            AND o.eliminated_user_id=p_eliminated_user_id
            AND o.mode <> 'mystery_chest' AND o.state='pending'
          ORDER BY o.hand_number, o.created_at LIMIT 1)
         OR (b.bounty_obligation_id IS NULL AND NOT EXISTS (
           SELECT 1 FROM tournament_bounty_obligations o
            WHERE o.tournament_id=p_tournament_id
              AND o.eliminated_user_id=p_eliminated_user_id
              AND o.mode <> 'mystery_chest' AND o.state='pending'))
       )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_collected');
  END IF;$new$;
  IF length(v_def)-length(replace(v_def,v_old,'')) <> length(v_old) THEN
    RAISE EXCEPTION 'fn_collect_bounty generation-idempotency substitution did not match exactly once';
  END IF;
  v_def := replace(v_def,v_old,v_new);

  v_old := $old$v_head := COALESCE(NULLIF(v_elim.current_bounty, 0), v_t.bounty_amount, 0);
  IF v_head <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_head_value');
  END IF;$old$;
  v_new := $new$v_head := COALESCE(NULLIF(v_elim.current_bounty, 0), v_t.bounty_amount, 0);
  IF v_head <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_head_value');
  END IF;
  IF EXISTS (
    SELECT 1 FROM tournament_bounty_obligations o
     WHERE o.tournament_id=p_tournament_id
       AND o.eliminated_user_id=p_eliminated_user_id
       AND o.mode <> 'mystery_chest' AND o.state='pending'
       AND o.head_amount IS DISTINCT FROM round(v_head,2)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'head_snapshot_changed');
  END IF;$new$;
  IF length(v_def)-length(replace(v_def,v_old,'')) <> length(v_old) THEN
    RAISE EXCEPTION 'fn_collect_bounty head-snapshot substitution did not match exactly once';
  END IF;
  v_def := replace(v_def,v_old,v_new);

  v_old := $old$v_payable := LEAST(v_head, v_available);$old$;
  v_new := $new$IF v_available < v_head THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'bounty_pool_underfunded',
                                'head', v_head, 'available', v_available);
    END IF;
    v_payable := v_head;$new$;
  IF length(v_def)-length(replace(v_def,v_old,'')) <> length(v_old) THEN
    RAISE EXCEPTION 'fn_collect_bounty full-head substitution did not match exactly once';
  END IF;
  EXECUTE replace(v_def,v_old,v_new);

  SELECT pg_get_functiondef('public.fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer)'::regprocedure)
    INTO v_def;
  v_old := $old$WHERE op_id = p_op_id
      OR (tournament_id = p_tournament_id AND eliminated_user_id = p_eliminated_user_id)$old$;
  v_new := $new$WHERE op_id = p_op_id
      OR (tournament_id = p_tournament_id AND eliminated_user_id = p_eliminated_user_id
          AND (
            bounty_obligation_id = (SELECT o.id FROM tournament_bounty_obligations o
              WHERE o.tournament_id=p_tournament_id
                AND o.eliminated_user_id=p_eliminated_user_id
                AND o.mode='mystery_chest' AND o.hand_id::text=p_hand_id
              ORDER BY o.created_at DESC LIMIT 1)
            OR (bounty_obligation_id IS NULL AND NOT EXISTS (
              SELECT 1 FROM tournament_bounty_obligations o
               WHERE o.tournament_id=p_tournament_id
                 AND o.eliminated_user_id=p_eliminated_user_id
                 AND o.mode='mystery_chest' AND o.hand_id::text=p_hand_id))
          ))$new$;
  IF length(v_def)-length(replace(v_def,v_old,'')) <> length(v_old) THEN
    RAISE EXCEPTION 'fn_mystery_bounty_reserve generation-idempotency substitution did not match exactly once';
  END IF;
  EXECUTE replace(v_def,v_old,v_new);

  -- The old payer named the pre-generation three-column conflict target.
  -- Once a player can re-enter that target no longer identifies a knockout,
  -- and neither new partial unique index can satisfy that inference. Bind the
  -- audit row to the award's exact obligation and use targetless conflict
  -- handling so both legacy and generation constraints remain replay-safe.
  SELECT pg_get_functiondef('public.fn_mystery_bounty_pay(uuid)'::regprocedure)
    INTO v_def;
  v_old := $old$INSERT INTO public.tournament_bounties
        (tournament_id, eliminated_player_id, collector_player_id, bounty_amount, is_mystery_revealed)
      VALUES (v_a.tournament_id, v_a.eliminated_user_id, v_r.user_id,
              (v_r.amount_cents / 100.0)::numeric, true)
      ON CONFLICT (tournament_id, eliminated_player_id, collector_player_id) DO NOTHING;$old$;
  v_new := $new$INSERT INTO public.tournament_bounties
        (tournament_id, eliminated_player_id, collector_player_id, bounty_amount,
         is_mystery_revealed, bounty_obligation_id)
      VALUES (v_a.tournament_id, v_a.eliminated_user_id, v_r.user_id,
              (v_r.amount_cents / 100.0)::numeric, true, v_a.bounty_obligation_id)
      ON CONFLICT DO NOTHING;$new$;
  IF length(v_def)-length(replace(v_def,v_old,'')) <> length(v_old) THEN
    RAISE EXCEPTION 'fn_mystery_bounty_pay generation-conflict substitution did not match exactly once';
  END IF;
  v_def := replace(v_def,v_old,v_new);

  -- A mystery award is one accounting unit. The former payer committed each
  -- successful recipient, counted refusals, and returned ok=true with an
  -- incomplete award. Recovery then became the normal path and a split chest
  -- could be visible in two different financial states. Raising on the first
  -- refusal rolls the whole function transaction back: no recipient marker,
  -- wallet credit, tournament counter or pool counter survives alone.
  v_old := $old$IF COALESCE(v_credited, false) THEN
      UPDATE public.tournament_bounty_award_recipients$old$;
  v_new := $new$IF COALESCE(v_credited, false)
       AND round(COALESCE((v_settle->>'paid')::numeric,0),2)
           = round((v_r.amount_cents / 100.0)::numeric,2) THEN
      UPDATE public.tournament_bounty_award_recipients$new$;
  IF length(v_def)-length(replace(v_def,v_old,'')) <> length(v_old) THEN
    RAISE EXCEPTION 'fn_mystery_bounty_pay exact-credit substitution did not match exactly once';
  END IF;
  v_def := replace(v_def,v_old,v_new);

  v_old := $old$ELSE
      v_refused := v_refused + 1;
    END IF;$old$;
  v_new := $new$ELSE
      RAISE EXCEPTION 'fn_mystery_bounty_pay: recipient % refused for award % (%)',
        v_r.user_id, p_award_id, COALESCE(v_settle->>'refused_reason','unknown')
        USING ERRCODE='check_violation';
    END IF;$new$;
  IF length(v_def)-length(replace(v_def,v_old,'')) <> length(v_old) THEN
    RAISE EXCEPTION 'fn_mystery_bounty_pay atomic-recipient substitution did not match exactly once';
  END IF;
  v_def := replace(v_def,v_old,v_new);

  v_old := $old$IF v_refused = 0 THEN
    UPDATE public.tournament_bounty_awards$old$;
  v_new := $new$-- A zero-cent split is still an explicitly settled recipient,
    -- not a NULL marker that completion can silently ignore.
    UPDATE public.tournament_bounty_award_recipients
       SET paid_at=COALESCE(paid_at,now())
     WHERE award_id=p_award_id AND amount_cents=0;

  IF v_refused = 0 AND NOT EXISTS (
    SELECT 1 FROM public.tournament_bounty_award_recipients
     WHERE award_id=p_award_id AND paid_at IS NULL
  ) THEN
    UPDATE public.tournament_bounty_awards$new$;
  IF length(v_def)-length(replace(v_def,v_old,'')) <> length(v_old) THEN
    RAISE EXCEPTION 'fn_mystery_bounty_pay paid-recipient substitution did not match exactly once';
  END IF;
  v_def := replace(v_def,v_old,v_new);

  v_old := $old$IF v_a.status = 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'award_id', p_award_id,
                              'amount_cents', v_a.amount_cents);
  END IF;$old$;
  v_new := $new$IF v_a.status = 'completed' THEN
    IF v_a.bounty_obligation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.tournament_bounty_obligations o
       WHERE o.id=v_a.bounty_obligation_id AND o.state='settled'
         AND public.fn_bounty_obligation_has_complete_marker(o.id)
    ) THEN
      RETURN jsonb_build_object('ok',false,'reason','completed_award_marker_incomplete',
                                'award_id',p_award_id);
    END IF;
    RETURN jsonb_build_object('ok', true, 'already', true, 'award_id', p_award_id,
                              'amount_cents', v_a.amount_cents);
  END IF;$new$;
  IF length(v_def)-length(replace(v_def,v_old,'')) <> length(v_old) THEN
    RAISE EXCEPTION 'fn_mystery_bounty_pay completed-marker substitution did not match exactly once';
  END IF;
  v_def := replace(v_def,v_old,v_new);

  v_old := $old$RETURN jsonb_build_object('ok', true, 'already', false, 'award_id', p_award_id,$old$;
  v_new := $new$IF v_a.bounty_obligation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.tournament_bounty_obligations o
     WHERE o.id=v_a.bounty_obligation_id AND o.state='settled'
       AND public.fn_bounty_obligation_has_complete_marker(o.id)
  ) THEN
    RAISE EXCEPTION 'mystery award % completed without its exact settled marker',p_award_id
      USING ERRCODE='check_violation';
  END IF;

  RETURN jsonb_build_object('ok', true, 'already', false, 'award_id', p_award_id,$new$;
  IF length(v_def)-length(replace(v_def,v_old,'')) <> length(v_old) THEN
    RAISE EXCEPTION 'fn_mystery_bounty_pay final-marker substitution did not match exactly once';
  END IF;
  EXECUTE replace(v_def,v_old,v_new);
END;
$do$;

-- Every mystery payer takes the tournament lock before its award lock.  The
-- terminal settler already owns the tournament first; wrapping direct payer
-- calls removes the inverse award->tournament order that could deadlock both.
DO $do$
BEGIN
  IF to_regprocedure('public.fn_mystery_bounty_pay_unguarded_20260907(uuid)') IS NULL THEN
    ALTER FUNCTION public.fn_mystery_bounty_pay(uuid)
      RENAME TO fn_mystery_bounty_pay_unguarded_20260907;
  END IF;
END;
$do$;

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_pay(p_award_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
BEGIN
  SELECT a.tournament_id INTO v_tournament_id
    FROM public.tournament_bounty_awards a WHERE a.id=p_award_id;
  IF v_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','award_not_found');
  END IF;
  PERFORM 1 FROM public.tournaments t WHERE t.id=v_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  RETURN public.fn_mystery_bounty_pay_unguarded_20260907(p_award_id);
END;
$function$;

-- Service callers keep the established signatures, but a durable outbox is
-- now the authority for who gets paid and in what proportions. The historical
-- arithmetic remains underneath these wrappers; it can no longer be invoked
-- directly by the engine role.
DO $do$
BEGIN
  IF to_regprocedure(
       'public.fn_collect_bounty_unguarded_20260907(uuid,uuid,uuid,jsonb)'
     ) IS NULL THEN
    ALTER FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb)
      RENAME TO fn_collect_bounty_unguarded_20260907;
  END IF;
END;
$do$;

CREATE OR REPLACE FUNCTION public.fn_collect_bounty(
  p_tournament_id uuid,
  p_eliminated_user_id uuid,
  p_collector_user_id uuid,
  p_claimants jsonb DEFAULT NULL::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  o public.tournament_bounty_obligations%ROWTYPE;
  v_result jsonb;
  v_shares jsonb;
  v_paid_cash numeric;
  v_added_to_head numeric;
  v_context text := current_setting('app.bounty_obligation_id',true);
  v_prior_context text;
  v_obligation_count integer;
  v_pko_watermark bigint;
BEGIN
  PERFORM 1 FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;

  IF COALESCE(v_context,'')
       ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    SELECT * INTO o FROM public.tournament_bounty_obligations bo
     WHERE bo.id=v_context::uuid AND bo.tournament_id=p_tournament_id
       AND bo.eliminated_user_id=p_eliminated_user_id
       AND bo.mode<>'mystery_chest'
     FOR UPDATE;
  ELSE
    SELECT count(*) INTO v_obligation_count
      FROM public.tournament_bounty_obligations bo
     WHERE bo.tournament_id=p_tournament_id
       AND bo.eliminated_user_id=p_eliminated_user_id
       AND bo.mode<>'mystery_chest';
    IF v_obligation_count>1 THEN
      RETURN jsonb_build_object('ok',false,'reason','bounty_generation_identity_required');
    END IF;
    SELECT * INTO o FROM public.tournament_bounty_obligations bo
     WHERE bo.tournament_id=p_tournament_id
       AND bo.eliminated_user_id=p_eliminated_user_id
       AND bo.mode<>'mystery_chest'
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','bounty_obligation_not_ready');
  END IF;
  IF o.mode='pko' THEN
    SELECT w.last_settled_hand_number INTO v_pko_watermark
      FROM public.tournament_pko_settlement_watermarks w
     WHERE w.tournament_id=o.tournament_id FOR UPDATE;
    IF v_pko_watermark IS NOT NULL AND o.hand_number<v_pko_watermark THEN
      RETURN jsonb_build_object('ok',false,'reason','pko_order_already_advanced',
                                'last_settled_hand_number',v_pko_watermark);
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.tournament_bounty_obligations prior
       WHERE prior.tournament_id=o.tournament_id AND prior.mode='pko'
         AND prior.state='pending' AND prior.hand_number<o.hand_number
    ) THEN
      RETURN jsonb_build_object('ok',false,'reason','pending_pko_predecessor');
    END IF;
  END IF;
  IF o.state='settled' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'user_id',b.collector_player_id,
             'cash',GREATEST(0,b.bounty_amount-COALESCE(b.added_to_collector_bounty,0)),
             'to_head',COALESCE(b.added_to_collector_bounty,0))
             ORDER BY b.collector_player_id),'[]'::jsonb),
           COALESCE(sum(GREATEST(0,b.bounty_amount-COALESCE(b.added_to_collector_bounty,0))),0),
           COALESCE(sum(b.added_to_collector_bounty),0)
      INTO v_shares,v_paid_cash,v_added_to_head
      FROM public.tournament_bounties b
     WHERE b.bounty_obligation_id=o.id;
    IF NOT public.fn_bounty_obligation_has_complete_marker(o.id) THEN
      RETURN jsonb_build_object('ok',false,'reason','settled_marker_incomplete',
                                'obligation_id',o.id);
    END IF;
    IF o.mode='pko' THEN
      INSERT INTO public.tournament_pko_settlement_watermarks
        (tournament_id,last_settled_hand_number,last_obligation_id)
      VALUES (o.tournament_id,o.hand_number,o.id)
      ON CONFLICT (tournament_id) DO UPDATE
        SET last_settled_hand_number=GREATEST(
              public.tournament_pko_settlement_watermarks.last_settled_hand_number,
              EXCLUDED.last_settled_hand_number),
            last_obligation_id=CASE
              WHEN EXCLUDED.last_settled_hand_number>=
                   public.tournament_pko_settlement_watermarks.last_settled_hand_number
              THEN EXCLUDED.last_obligation_id
              ELSE public.tournament_pko_settlement_watermarks.last_obligation_id END,
            updated_at=now();
    END IF;
    RETURN jsonb_build_object('ok',true,'already',true,'obligation_id',o.id,
      'marker_verified',true,'mode',o.mode,'head',o.head_amount,
      'paid_cash',v_paid_cash,'added_to_head',v_added_to_head,
      'split',jsonb_array_length(v_shares)>1,'shares',v_shares);
  END IF;

  -- Ignore caller ordering/weights. The exact pot-derived, roster-validated
  -- snapshot stored by the atomic claim is the only payout authority.
  v_prior_context := current_setting('app.bounty_obligation_id',true);
  PERFORM set_config('app.bounty_obligation_id',o.id::text,true);
  v_result := public.fn_collect_bounty_unguarded_20260907(
    p_tournament_id,p_eliminated_user_id,o.knocker_user_id,o.claimants);
  PERFORM set_config('app.bounty_obligation_id',COALESCE(v_prior_context,''),true);

  IF NOT COALESCE((v_result->>'ok')::boolean,false) THEN
    -- A semantic pre-write refusal is safe to commit and stays pending. Any
    -- accepted payer result below must satisfy the exact marker postcondition
    -- or raise so its wallet/head/counter mutations roll back atomically.
    RETURN v_result || jsonb_build_object('obligation_id',o.id);
  END IF;

  UPDATE public.tournament_bounty_obligations bo
     SET state='settled',settled_at=COALESCE(settled_at,now()),last_error=NULL
   WHERE bo.id=o.id AND bo.state='pending'
     AND public.fn_bounty_obligation_has_complete_marker(bo.id);
  IF NOT public.fn_bounty_obligation_has_complete_marker(o.id)
     OR NOT EXISTS (SELECT 1 FROM public.tournament_bounty_obligations bo
                     WHERE bo.id=o.id AND bo.state='settled') THEN
    RAISE EXCEPTION 'accepted bounty payout did not produce the exact settled marker for %',o.id
      USING ERRCODE='check_violation';
  END IF;
  IF o.mode='pko' THEN
    INSERT INTO public.tournament_pko_settlement_watermarks
      (tournament_id,last_settled_hand_number,last_obligation_id)
    VALUES (o.tournament_id,o.hand_number,o.id)
    ON CONFLICT (tournament_id) DO UPDATE
      SET last_settled_hand_number=GREATEST(
            public.tournament_pko_settlement_watermarks.last_settled_hand_number,
            EXCLUDED.last_settled_hand_number),
          last_obligation_id=CASE
            WHEN EXCLUDED.last_settled_hand_number>=
                 public.tournament_pko_settlement_watermarks.last_settled_hand_number
            THEN EXCLUDED.last_obligation_id
            ELSE public.tournament_pko_settlement_watermarks.last_obligation_id END,
          updated_at=now();
  END IF;
  RETURN v_result || jsonb_build_object('obligation_id',o.id,'marker_verified',true);
END;
$function$;

-- Exact worker entry point.  The compatibility signature cannot identify a
-- retry once the same player has bought a second generation, so durable work
-- always names the obligation itself.
CREATE OR REPLACE FUNCTION public.fn_collect_bounty_obligation(p_obligation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  o public.tournament_bounty_obligations%ROWTYPE;
  v_prior_context text := current_setting('app.bounty_obligation_id',true);
  v_result jsonb;
BEGIN
  SELECT * INTO o FROM public.tournament_bounty_obligations WHERE id=p_obligation_id;
  IF NOT FOUND OR o.mode='mystery_chest' THEN
    RETURN jsonb_build_object('ok',false,'reason','bounty_obligation_not_found');
  END IF;
  PERFORM set_config('app.bounty_obligation_id',o.id::text,true);
  v_result := public.fn_collect_bounty(
    o.tournament_id,o.eliminated_user_id,o.knocker_user_id,o.claimants);
  PERFORM set_config('app.bounty_obligation_id',COALESCE(v_prior_context,''),true);
  RETURN v_result;
END;
$function$;

DO $do$
BEGIN
  IF to_regprocedure(
       'public.fn_mystery_bounty_reserve_unguarded_20260907(uuid,uuid,jsonb,uuid,text,uuid,integer)'
     ) IS NULL THEN
    ALTER FUNCTION public.fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer)
      RENAME TO fn_mystery_bounty_reserve_unguarded_20260907;
  END IF;
END;
$do$;

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_reserve(
  p_tournament_id uuid,
  p_eliminated_user_id uuid,
  p_recipients jsonb,
  p_table_id uuid,
  p_hand_id text,
  p_op_id uuid,
  p_reveal_ms integer DEFAULT 20000
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  o public.tournament_bounty_obligations%ROWTYPE;
  v_recipients jsonb;
  v_result jsonb;
  v_op_hex text;
  v_op_id uuid;
  v_prior_context text;
BEGIN
  PERFORM 1 FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;
  SELECT * INTO o FROM public.tournament_bounty_obligations bo
   WHERE bo.tournament_id=p_tournament_id
     AND bo.eliminated_user_id=p_eliminated_user_id
     AND bo.mode='mystery_chest'
     AND bo.table_id=p_table_id AND bo.hand_id::text=p_hand_id
   ORDER BY bo.hand_number DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','bounty_obligation_not_ready');
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'user_id',e->>'user_id','weight',1,
           'is_designated_revealer',(e->>'user_id')::uuid=o.knocker_user_id)
           ORDER BY e->>'user_id')
    INTO v_recipients FROM jsonb_array_elements(o.claimants) e;
  v_op_hex := md5('mb:'||o.id::text);
  v_op_id := (substr(v_op_hex,1,8)||'-'||substr(v_op_hex,9,4)||'-4'||substr(v_op_hex,14,3)
    ||'-8'||substr(v_op_hex,18,3)||'-'||substr(v_op_hex,21,12))::uuid;
  v_prior_context := current_setting('app.bounty_obligation_id',true);
  PERFORM set_config('app.bounty_obligation_id',o.id::text,true);
  v_result := public.fn_mystery_bounty_reserve_unguarded_20260907(
    o.tournament_id,o.eliminated_user_id,v_recipients,o.table_id,o.hand_id::text,
    v_op_id,p_reveal_ms);
  PERFORM set_config('app.bounty_obligation_id',COALESCE(v_prior_context,''),true);
  IF NOT COALESCE((v_result->>'ok')::boolean,false) THEN RETURN v_result; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_bounty_awards a
     WHERE a.id=(v_result->>'award_id')::uuid AND a.bounty_obligation_id=o.id
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(o.claimants) c
          WHERE NOT EXISTS (SELECT 1 FROM public.tournament_bounty_award_recipients r
                             WHERE r.award_id=a.id
                               AND r.user_id=(c->>'user_id')::uuid)
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_award_recipients r
          WHERE r.award_id=a.id
            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(o.claimants) c
                             WHERE (c->>'user_id')::uuid=r.user_id)
       )
  ) THEN
    RAISE EXCEPTION 'mystery award recipients do not match obligation %',o.id;
  END IF;
  RETURN v_result || jsonb_build_object('obligation_id',o.id,'recipients_verified',true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_sweep_pending_tournament_bounties(
  p_tournament_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  o public.tournament_bounty_obligations%ROWTYPE;
  candidate record;
  v_result jsonb;
  v_reserved jsonb;
  v_award_id uuid;
  v_processed integer := 0;
  v_settled integer := 0;
  v_failed integer := 0;
  v_settled_tournament_ids uuid[] := ARRAY[]::uuid[];
  v_recipients jsonb;
  v_op_hex text;
  v_op_id uuid;
  v_limit integer := GREATEST(1,LEAST(COALESCE(p_limit,20),100));
BEGIN
  FOR candidate IN
    SELECT bo.id, bo.tournament_id FROM public.tournament_bounty_obligations bo
     WHERE bo.state = 'pending'
       AND bo.next_attempt_at <= now()
       AND (p_tournament_id IS NULL OR bo.tournament_id = p_tournament_id)
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_obligations prior
          WHERE prior.tournament_id=bo.tournament_id AND prior.state='pending'
            AND prior.mode='pko'
            AND (prior.hand_number < bo.hand_number
                 OR (prior.hand_number=bo.hand_number
                     AND prior.eliminated_user_id::text < bo.eliminated_user_id::text))
       )
     ORDER BY bo.next_attempt_at, bo.tournament_id, bo.hand_number,
              bo.eliminated_user_id
     LIMIT v_limit
  LOOP
    BEGIN
      -- One lock order everywhere: tournament then obligation. Direct manager
      -- collection also locks tournament before its ledger trigger touches the
      -- outbox, so the global lane cannot deadlock it outbox->tournament.
      PERFORM 1 FROM public.tournaments t WHERE t.id=candidate.tournament_id FOR UPDATE;
      SELECT * INTO o FROM public.tournament_bounty_obligations bo
       WHERE bo.id=candidate.id AND bo.state='pending' AND bo.next_attempt_at<=now()
       FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN CONTINUE; END IF;
      -- The candidate query ran before these locks. Re-prove ordering after the
      -- tournament and exact obligation are locked so a predecessor committed
      -- in that window cannot be skipped.
      IF o.mode='pko' AND EXISTS (
        SELECT 1 FROM public.tournament_bounty_obligations prior
         WHERE prior.tournament_id=o.tournament_id AND prior.mode='pko'
           AND prior.state='pending'
           AND (prior.hand_number<o.hand_number
                OR (prior.hand_number=o.hand_number
                    AND prior.eliminated_user_id::text<o.eliminated_user_id::text))
      ) THEN
        CONTINUE;
      END IF;
      v_processed := v_processed + 1;

      -- Response-loss reconciliation before another call.
      IF o.mode <> 'mystery_chest'
         AND public.fn_bounty_obligation_has_complete_marker(o.id) THEN
        UPDATE public.tournament_bounty_obligations SET state='settled', settled_at=now(), last_error=NULL
         WHERE id=o.id;
        v_settled := v_settled + 1;
        IF NOT o.tournament_id=ANY(v_settled_tournament_ids) THEN
          v_settled_tournament_ids := array_append(v_settled_tournament_ids,o.tournament_id);
        END IF;
        CONTINUE;
      ELSIF o.mode = 'mystery_chest'
         AND public.fn_bounty_obligation_has_complete_marker(o.id) THEN
        UPDATE public.tournament_bounty_obligations SET state='settled', settled_at=now(), last_error=NULL
         WHERE id=o.id;
        v_settled := v_settled + 1;
        IF NOT o.tournament_id=ANY(v_settled_tournament_ids) THEN
          v_settled_tournament_ids := array_append(v_settled_tournament_ids,o.tournament_id);
        END IF;
        CONTINUE;
      END IF;

      IF o.mode = 'mystery_chest' THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'user_id', x.user_id, 'weight', x.weight,
          'is_designated_revealer', x.user_id = o.knocker_user_id
        )), '[]'::jsonb)
        INTO v_recipients
        FROM (
          SELECT (e->>'user_id')::uuid AS user_id,
                 GREATEST(COALESCE((e->>'weight')::numeric, 0), 0) AS weight
            FROM jsonb_array_elements(o.claimants) e
           WHERE NULLIF(e->>'user_id','') IS NOT NULL
        ) x;
        v_op_hex := md5('mb:' || o.id::text);
        v_op_id := (substr(v_op_hex,1,8)||'-'||substr(v_op_hex,9,4)||'-4'||substr(v_op_hex,14,3)
          ||'-8'||substr(v_op_hex,18,3)||'-'||substr(v_op_hex,21,12))::uuid;
        v_reserved := public.fn_mystery_bounty_reserve(
          o.tournament_id, o.eliminated_user_id, v_recipients, o.table_id,
          o.hand_id::text, v_op_id, 1);
        IF NOT COALESCE((v_reserved->>'ok')::boolean, false) THEN
          RAISE EXCEPTION 'reserve refused: %', COALESCE(v_reserved->>'reason','unknown');
        END IF;
        v_award_id := (v_reserved->>'award_id')::uuid;
        IF COALESCE(v_reserved->>'status','') <> 'completed' THEN
          v_result := public.fn_mystery_bounty_reveal(v_award_id, NULL, true);
          IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN
            RAISE EXCEPTION 'reveal refused';
          END IF;
          v_result := public.fn_mystery_bounty_pay(v_award_id);
          IF NOT COALESCE((v_result->>'ok')::boolean, false)
             OR COALESCE((v_result->>'refused_recipients')::integer,0) > 0 THEN
            RAISE EXCEPTION 'pay refused or incomplete';
          END IF;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                        WHERE a.bounty_obligation_id=o.id AND a.status='completed') THEN
          RAISE EXCEPTION 'mystery payout has no completed award marker';
        END IF;
      ELSE
        v_result := public.fn_collect_bounty_obligation(o.id);
        IF NOT COALESCE((v_result->>'ok')::boolean, false)
           AND COALESCE(v_result->>'reason','') <> 'already_collected' THEN
          RAISE EXCEPTION 'collect refused: %', COALESCE(v_result->>'reason','unknown');
        END IF;
        IF NOT public.fn_bounty_obligation_has_complete_marker(o.id) THEN
          RAISE EXCEPTION 'fixed/PKO payout markers do not conserve the full generation head';
        END IF;
      END IF;

      -- Triggers settle only after every canonical claimant (or the completed
      -- award) is durable. Never infer success from an RPC transport response.
      IF NOT EXISTS (SELECT 1 FROM public.tournament_bounty_obligations x
                      WHERE x.id=o.id AND x.state='settled') THEN
        RAISE EXCEPTION 'payout marker did not acknowledge obligation';
      END IF;
      UPDATE public.tournament_bounty_obligations
         SET last_error=NULL, attempt_count=attempt_count+1
       WHERE id=o.id;
      v_settled := v_settled + 1;
      IF NOT o.tournament_id=ANY(v_settled_tournament_ids) THEN
        v_settled_tournament_ids := array_append(v_settled_tournament_ids,o.tournament_id);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.tournament_bounty_obligations
       SET attempt_count=attempt_count+1, last_error=left(SQLERRM,1000),
             next_attempt_at=clock_timestamp()
               + make_interval(secs => LEAST(60, 5 * (attempt_count + 1)))
       WHERE id=candidate.id;
      v_failed := v_failed + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'processed', v_processed,
    'settled', v_settled, 'failed', v_failed,
    'settled_tournament_ids',to_jsonb(v_settled_tournament_ids),
    'pending', (SELECT count(*) FROM public.tournament_bounty_obligations
      WHERE state='pending' AND (p_tournament_id IS NULL OR tournament_id=p_tournament_id)),
    -- Return a DATABASE-CLOCK RELATIVE delay for the first order-eligible
    -- head. A later PKO row can have due=now while an earlier generation is
    -- backed off; using the raw minimum would spin the engine until the head
    -- became due. A host timestamp would repeat that bug under clock skew.
    'retry_after_ms',(
      SELECT CASE WHEN due_at IS NULL THEN NULL ELSE
        GREATEST(0,ceil(extract(epoch FROM (due_at-clock_timestamp()))*1000)::bigint)
      END
      FROM (
        SELECT min(bo.next_attempt_at) AS due_at
          FROM public.tournament_bounty_obligations bo
         WHERE bo.state='pending'
           AND (p_tournament_id IS NULL OR bo.tournament_id=p_tournament_id)
           AND NOT EXISTS (
             SELECT 1 FROM public.tournament_bounty_obligations prior
              WHERE prior.tournament_id=bo.tournament_id AND prior.state='pending'
                AND prior.mode='pko'
                AND (prior.hand_number<bo.hand_number
                     OR (prior.hand_number=bo.hand_number
                         AND prior.eliminated_user_id::text<bo.eliminated_user_id::text))
           )
      ) eligible_head
    ));
END;
$function$;

-- Retried drafts of this migration may already have installed the former
-- reconstruction RPCs. Replace every caller first, then remove both surfaces
-- explicitly so a resumed rollout cannot leave either function callable.
DROP FUNCTION IF EXISTS public.fn_backfill_legacy_tournament_bounty_obligations(uuid,integer);
DROP FUNCTION IF EXISTS public.fn_backfill_legacy_tournament_bounty_obligations_page(uuid,integer);

CREATE OR REPLACE FUNCTION public.fn_tournament_has_unsettled_bounties(p_tournament_id uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    EXISTS (
      SELECT 1 FROM public.tournament_bounty_obligations o
       WHERE o.tournament_id=p_tournament_id AND o.state='pending'
    )
    OR EXISTS (
      -- `settled` is only a cache of the marker trigger's last verdict. The
      -- canonical ledger/award can never be allowed to drift underneath it:
      -- finalisation re-proves the complete generation marker every time.
      SELECT 1 FROM public.tournament_bounty_obligations o
       WHERE o.tournament_id=p_tournament_id AND o.state='settled'
         AND NOT public.fn_bounty_obligation_has_complete_marker(o.id)
    )
    OR EXISTS (
      SELECT 1 FROM public.tournament_bounty_awards a
       WHERE a.tournament_id=p_tournament_id AND a.status IN ('reserved','revealed','paid')
    );
$function$;

-- Guard direct repair/backpay callers by wrapping the canonical finaliser.
DO $do$
BEGIN
  IF to_regprocedure('public.fn_finalize_bounty_pool_unguarded_20260907(uuid,uuid)') IS NULL THEN
    ALTER FUNCTION public.fn_finalize_bounty_pool(uuid,uuid)
      RENAME TO fn_finalize_bounty_pool_unguarded_20260907;
  END IF;
END;
$do$;

CREATE OR REPLACE FUNCTION public.fn_finalize_bounty_pool(p_tournament_id uuid, p_winner_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_t public.tournaments%ROWTYPE;
  v_canonical_winner uuid;
  v_winner_count integer;
  v_receipt public.tournament_bounty_completion_receipts%ROWTYPE;
BEGIN
  SELECT * INTO v_receipt FROM public.tournament_bounty_completion_receipts
   WHERE tournament_id=p_tournament_id AND pool_finalized_at IS NOT NULL;
  IF FOUND THEN
    IF v_receipt.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR jsonb_typeof(v_receipt.pool_result) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('ok',false,'reason','completion_receipt_conflict');
    END IF;
    RETURN v_receipt.pool_result;
  END IF;
  SELECT * INTO v_t FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
  SELECT * INTO v_receipt FROM public.tournament_bounty_completion_receipts
   WHERE tournament_id=p_tournament_id AND pool_finalized_at IS NOT NULL;
  IF FOUND THEN
    IF v_receipt.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR jsonb_typeof(v_receipt.pool_result) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('ok',false,'reason','completion_receipt_conflict');
    END IF;
    RETURN v_receipt.pool_result;
  END IF;
  SELECT count(DISTINCT tp.user_id),(array_agg(tp.user_id ORDER BY tp.user_id))[1]
    INTO v_winner_count,v_canonical_winner
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status='winner' AND tp.position=1;
  IF v_winner_count<>1 OR p_winner_user_id IS DISTINCT FROM v_canonical_winner THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_tournament_winner');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_bounty_completion_receipts r
              WHERE r.tournament_id=p_tournament_id
                AND r.winner_user_id IS DISTINCT FROM p_winner_user_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','completion_winner_conflict');
  END IF;
  IF public.fn_tournament_has_unsettled_bounties(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','pending_bounty_obligations');
  END IF;
  IF COALESCE(v_t.is_mystery_bounty,false)
     AND v_t.mystery_bounty_stage IS DISTINCT FROM 'pending'
     AND NOT EXISTS (SELECT 1 FROM public.tournament_bounty_completion_receipts r
                      WHERE r.tournament_id=p_tournament_id
                        AND r.mystery_settled_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok',false,'reason','mystery_bounty_not_settled');
  END IF;
  v_result := public.fn_finalize_bounty_pool_unguarded_20260907(
    p_tournament_id,p_winner_user_id);
  IF COALESCE((v_result->>'ok')::boolean,false) THEN
    INSERT INTO public.tournament_bounty_completion_receipts
      (tournament_id,winner_user_id,pool_finalized_at,pool_result,updated_at)
    VALUES (p_tournament_id,p_winner_user_id,now(),v_result,now())
    ON CONFLICT (tournament_id) DO UPDATE
      SET pool_finalized_at=COALESCE(public.tournament_bounty_completion_receipts.pool_finalized_at,EXCLUDED.pool_finalized_at),
          pool_result=COALESCE(public.tournament_bounty_completion_receipts.pool_result,EXCLUDED.pool_result),
          winner_user_id=COALESCE(public.tournament_bounty_completion_receipts.winner_user_id,EXCLUDED.winner_user_id),
          updated_at=now();
  END IF;
  RETURN v_result;
END;
$function$;

-- The old mystery settle voided reserved/revealed awards to the champion. It
-- may still void genuinely available inventory, but never an earned award.
DO $do$
BEGIN
  IF to_regprocedure('public.fn_mystery_bounty_settle_unguarded_20260907(uuid,uuid)') IS NULL THEN
    ALTER FUNCTION public.fn_mystery_bounty_settle(uuid,uuid)
      RENAME TO fn_mystery_bounty_settle_unguarded_20260907;
  END IF;
END;
$do$;

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_settle(p_tournament_id uuid, p_winner_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_step jsonb;
  v_canonical_winner uuid;
  v_winner_count integer;
  v_receipt public.tournament_bounty_completion_receipts%ROWTYPE;
  v_award record;
BEGIN
  -- A completed terminal receipt is the answer even after awards were voided,
  -- the stage changed, or standings were archived.  Those mutable rows cannot
  -- be used to reconstruct a prior result.
  SELECT * INTO v_receipt FROM public.tournament_bounty_completion_receipts
   WHERE tournament_id=p_tournament_id AND mystery_settled_at IS NOT NULL;
  IF FOUND THEN
    IF v_receipt.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR jsonb_typeof(v_receipt.mystery_result) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('ok',false,'reason','completion_receipt_conflict');
    END IF;
    RETURN v_receipt.mystery_result;
  END IF;
  PERFORM 1 FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;
  SELECT * INTO v_receipt FROM public.tournament_bounty_completion_receipts
   WHERE tournament_id=p_tournament_id AND mystery_settled_at IS NOT NULL;
  IF FOUND THEN
    IF v_receipt.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR jsonb_typeof(v_receipt.mystery_result) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('ok',false,'reason','completion_receipt_conflict');
    END IF;
    RETURN v_receipt.mystery_result;
  END IF;
  SELECT count(DISTINCT tp.user_id),(array_agg(tp.user_id ORDER BY tp.user_id))[1]
    INTO v_winner_count,v_canonical_winner
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status='winner' AND tp.position=1;
  IF v_winner_count<>1 OR p_winner_user_id IS DISTINCT FROM v_canonical_winner THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_tournament_winner');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_bounty_completion_receipts r
              WHERE r.tournament_id=p_tournament_id
                AND r.winner_user_id IS DISTINCT FROM p_winner_user_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','completion_winner_conflict');
  END IF;
  -- Reserved/revealed awards are earned debts, not inventory the champion may
  -- absorb.  Resolve each exact award under the tournament lock before the
  -- historical terminal body calculates the genuinely unclaimed inventory.
  FOR v_award IN
    SELECT a.id,a.status FROM public.tournament_bounty_awards a
     WHERE a.tournament_id=p_tournament_id
       AND a.status IN ('reserved','revealed','paid')
     ORDER BY a.id FOR UPDATE
  LOOP
    IF v_award.status='reserved' THEN
      v_step := public.fn_mystery_bounty_reveal(v_award.id,NULL,true);
      IF NOT COALESCE((v_step->>'ok')::boolean,false) THEN
        RAISE EXCEPTION 'terminal mystery reveal refused for award %: %',
          v_award.id,COALESCE(v_step::text,'null') USING ERRCODE='check_violation';
      END IF;
    END IF;
    v_step := public.fn_mystery_bounty_pay(v_award.id);
    IF NOT COALESCE((v_step->>'ok')::boolean,false)
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_awards a
          WHERE a.id=v_award.id AND a.status='completed'
            AND NOT EXISTS (
              SELECT 1 FROM public.tournament_bounty_award_recipients r
               WHERE r.award_id=a.id AND r.paid_at IS NULL
            )
       ) THEN
      RAISE EXCEPTION 'terminal mystery payment incomplete for award %: %',
        v_award.id,COALESCE(v_step::text,'null') USING ERRCODE='check_violation';
    END IF;
  END LOOP;
  IF public.fn_tournament_has_unsettled_bounties(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','pending_bounty_obligations');
  END IF;
  v_result := public.fn_mystery_bounty_settle_unguarded_20260907(
    p_tournament_id,p_winner_user_id);
  IF NOT COALESCE((v_result->>'ok')::boolean,false)
     OR NOT COALESCE((v_result->>'balanced')::boolean,false) THEN
    -- The historical body can already have paid a clamp/residual or voided a
    -- chest before reporting imbalance. A normal RETURN would commit that
    -- partial terminal state. The guarded contract is all-or-nothing.
    RAISE EXCEPTION 'mystery bounty settlement refused or unbalanced: %',v_result
      USING ERRCODE='check_violation';
  END IF;
  INSERT INTO public.tournament_bounty_completion_receipts
    (tournament_id,winner_user_id,mystery_settled_at,mystery_result,updated_at)
  VALUES (p_tournament_id,p_winner_user_id,now(),v_result,now())
  ON CONFLICT (tournament_id) DO UPDATE
    SET mystery_settled_at=COALESCE(public.tournament_bounty_completion_receipts.mystery_settled_at,EXCLUDED.mystery_settled_at),
        mystery_result=COALESCE(public.tournament_bounty_completion_receipts.mystery_result,EXCLUDED.mystery_result),
        winner_user_id=COALESCE(public.tournament_bounty_completion_receipts.winner_user_id,EXCLUDED.winner_user_id),
        updated_at=now();
  RETURN v_result;
END;
$function$;

-- A chop is one transaction. The historical body reports per-recipient
-- refusals while still committing successful shares; this wrapper turns any
-- refusal or total mismatch into an exception so PostgreSQL rolls the entire
-- underlying call back. It also shares the tournament lock/guard with claims.
DO $do$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  IF to_regprocedure('public.fn_final_table_deal_unguarded_20260907(uuid)') IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT pg_get_functiondef('public.fn_final_table_deal(uuid)'::regprocedure)
    INTO v_def;
  v_old := $old$SELECT COALESCE(sum(prize), 0) INTO v_awarded
    FROM public.tournament_players WHERE tournament_id = p_tournament_id;
  SELECT v_awarded + COALESCE(sum(amount), 0) INTO v_awarded
    FROM public.tournament_payouts WHERE tournament_id = p_tournament_id;$old$;
  v_new := $new$-- tournament_players.prize is a display cache of the same
  -- payments recorded append-only in tournament_payouts. Summing both counts
  -- every settled place twice and underprices the deal. The payout ledger is
  -- the sole authority for prize-pool money already distributed.
  SELECT COALESCE(sum(amount),0) INTO v_awarded
    FROM public.tournament_payouts
   WHERE tournament_id=p_tournament_id
     AND COALESCE(source,'') NOT IN
       ('satellite_seat','bounty','mystery_bounty','bounty_residual',
        'own_bounty','mystery_bounty_residual');$new$;
  IF length(v_def)-length(replace(v_def,v_old,''))<>length(v_old) THEN
    RAISE EXCEPTION 'fn_final_table_deal canonical-awarded substitution did not match exactly once';
  END IF;
  EXECUTE replace(v_def,v_old,v_new);
END;
$do$;

DO $do$
BEGIN
  IF to_regprocedure('public.fn_final_table_deal_unguarded_20260907(uuid)') IS NULL THEN
    ALTER FUNCTION public.fn_final_table_deal(uuid)
      RENAME TO fn_final_table_deal_unguarded_20260907;
  END IF;
END;
$do$;

CREATE OR REPLACE FUNCTION public.fn_final_table_deal(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_expected numeric;
  v_settled numeric;
  v_receipt public.tournament_final_table_deal_receipts%ROWTYPE;
BEGIN
  SELECT * INTO v_receipt FROM public.tournament_final_table_deal_receipts
   WHERE tournament_id=p_tournament_id;
  IF FOUND THEN
    RETURN v_receipt.result;
  END IF;
  PERFORM 1 FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;
  SELECT * INTO v_receipt FROM public.tournament_final_table_deal_receipts
   WHERE tournament_id=p_tournament_id;
  IF FOUND THEN
    RETURN v_receipt.result;
  END IF;
  IF public.fn_tournament_has_unsettled_bounties(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','pending_bounty_obligations');
  END IF;
  v_result := public.fn_final_table_deal_unguarded_20260907(p_tournament_id);
  IF COALESCE((v_result->>'ok')::boolean,false) THEN
    v_expected := COALESCE((v_result->>'undistributed')::numeric,0);
    v_settled := COALESCE((v_result->>'settled')::numeric,0);
    IF jsonb_typeof(v_result->'refusals') <> 'array'
       OR jsonb_array_length(v_result->'refusals') > 0
       OR round(v_settled,2) <> round(v_expected,2) THEN
      RAISE EXCEPTION 'final table deal is not all-or-nothing (expected %, settled %, refusals %)',
        v_expected,v_settled,COALESCE(v_result->'refusals','null'::jsonb);
    END IF;
    INSERT INTO public.tournament_final_table_deal_receipts
      (tournament_id,payouts,chip_leader,expected_amount,settled_amount,result)
    VALUES (p_tournament_id,COALESCE(v_result->'payouts','[]'::jsonb),
            (v_result->>'chip_leader')::uuid,round(v_expected,2),round(v_settled,2),v_result);
  END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_refuse_completed_with_pending_bounties()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED'
     AND (COALESCE(NEW.is_bounty,false) OR COALESCE(NEW.is_pko,false)
          OR COALESCE(NEW.is_mystery_bounty,false)) THEN
    IF public.fn_tournament_has_unsettled_bounties(NEW.id) THEN
      RAISE EXCEPTION 'tournament % has pending bounty obligations', NEW.id
        USING ERRCODE='check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.tournament_bounty_completion_receipts r
                    WHERE r.tournament_id=NEW.id AND r.pool_finalized_at IS NOT NULL) THEN
      RAISE EXCEPTION 'tournament % bounty pool has not been finalized', NEW.id
        USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- A manager stops as soon as a certified tournament becomes COMPLETED. Any
-- durable wake left for that manager is therefore terminally satisfied, not
-- future work. Retire the exact pending set only AFTER the status update has
-- passed every BEFORE completion guard. This UPDATE remains in the same
-- transaction: if any later trigger or caller statement fails, both the
-- completion and every consumed_at marker roll back together.
CREATE OR REPLACE FUNCTION public.fn_retire_manager_wakes_after_terminal_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  IF upper(COALESCE(NEW.status,'')) IN ('COMPLETED','CANCELLED','CANCELED')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE public.tournament_manager_wakes
       SET consumed_at=COALESCE(consumed_at,clock_timestamp())
     WHERE tournament_id=NEW.id AND consumed_at IS NULL;
  END IF;
  RETURN NEW;
END;
$function$;

-- fn_collect_bounty intentionally refuses after the mystery chest phase opens.
-- Hold that one-way transition until every pre-phase head is durably paid;
-- otherwise a correctly persisted mystery_pre obligation would become
-- impossible to replay after a later stage change.
CREATE OR REPLACE FUNCTION public.fn_refuse_mystery_activation_with_pending_heads()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  IF NEW.mystery_bounty_stage = 'active'
     AND OLD.mystery_bounty_stage IS DISTINCT FROM 'active' THEN
    IF public.fn_tournament_has_unsettled_bounties(NEW.id) THEN
      RAISE EXCEPTION 'tournament % has pending pre-mystery bounty obligations', NEW.id
        USING ERRCODE='check_violation';
    END IF;
    NEW.mystery_bounty_activation_generation :=
      OLD.mystery_bounty_activation_generation + 1;
  ELSIF NEW.mystery_bounty_activation_generation
            IS DISTINCT FROM OLD.mystery_bounty_activation_generation THEN
    RAISE EXCEPTION 'mystery activation generation is database-managed'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_receipt_mystery_activation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_chest_count integer;
  v_pool_cents bigint;
  v_receipt public.tournament_mystery_activation_receipts%ROWTYPE;
BEGIN
  IF NEW.mystery_bounty_stage='active'
     AND OLD.mystery_bounty_stage IS DISTINCT FROM 'active' THEN
    SELECT count(*)::integer,COALESCE(sum(c.amount_cents),0)::bigint
      INTO v_chest_count,v_pool_cents
      FROM public.tournament_bounty_chests c WHERE c.tournament_id=NEW.id;
    IF v_chest_count<=0 OR v_pool_cents<=0
       OR v_pool_cents IS DISTINCT FROM NEW.mystery_bounty_pool_cents THEN
      RAISE EXCEPTION 'mystery activation inventory is missing or does not match its sealed pool'
        USING ERRCODE='check_violation';
    END IF;
    INSERT INTO public.tournament_mystery_activation_receipts
      (tournament_id,activation_generation,activated_at,chest_count,pool_cents)
    VALUES (NEW.id,NEW.mystery_bounty_activation_generation,
            COALESCE(NEW.mystery_bounty_activated_at,now()),v_chest_count,v_pool_cents)
    ON CONFLICT (tournament_id,activation_generation) DO NOTHING;
    SELECT * INTO v_receipt FROM public.tournament_mystery_activation_receipts
     WHERE tournament_id=NEW.id
       AND activation_generation=NEW.mystery_bounty_activation_generation;
    IF NOT FOUND OR v_receipt.chest_count<>v_chest_count
       OR v_receipt.pool_cents<>v_pool_cents THEN
      RAISE EXCEPTION 'mystery activation receipt identity conflict'
        USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- The existing measured repair used to count a guarded `{ok:false}` response
-- as an event settled. With pending obligations now a normal fail-closed
-- outcome, that would turn an unpaid pool into a false green repair report.
DO $do$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(
    'public.fn_backpay_unfinalised_bounty_pools(boolean,integer)'::regprocedure)
    INTO v_def;
  IF position('events_refused' IN v_def)>0
     AND position('v_refused integer := 0' IN v_def)>0 THEN
    RETURN;
  END IF;
  v_old := $old$v_events integer := 0; v_paid numeric := 0;
  v_orphan integer := 0; v_orphan_chips numeric := 0; v_alerts integer := 0;$old$;
  v_new := $new$v_events integer := 0; v_paid numeric := 0; v_refused integer := 0;
  v_orphan integer := 0; v_orphan_chips numeric := 0; v_alerts integer := 0;$new$;
  IF length(v_def)-length(replace(v_def,v_old,'')) <> length(v_old) THEN
    RAISE EXCEPTION 'backpay refusal counter substitution did not match exactly once';
  END IF;
  v_def := replace(v_def,v_old,v_new);

  v_old := $old$IF p_apply THEN
      v_res := public.fn_finalize_bounty_pool(r.id, r.champion);
      IF COALESCE((v_res->>'ok')::boolean, false) THEN
        v_paid := v_paid + COALESCE((v_res->>'residual')::numeric, 0);
      END IF;
    ELSE
      v_paid := v_paid + (r.pool - r.wallet_bounty);
    END IF;
    v_events := v_events + 1;$old$;
  v_new := $new$IF p_apply THEN
      v_res := public.fn_finalize_bounty_pool(r.id, r.champion);
      IF COALESCE((v_res->>'ok')::boolean, false) THEN
        v_paid := v_paid + COALESCE((v_res->>'residual')::numeric, 0);
        v_events := v_events + 1;
      ELSE
        v_refused := v_refused + 1;
        PERFORM public.fn_raise_server_financial_alert(
          'critical','fn_backpay_unfinalised_bounty_pools',
          format('Bounty-pool backpay for %s was refused and remains unpaid',COALESCE(r.name,r.id::text)),
          jsonb_build_object('kind','finalizer_refused','tournament_id',r.id,
            'reason',COALESCE(v_res->>'reason','unknown'),'result',v_res),r.id::text);
        v_alerts := v_alerts + 1;
      END IF;
    ELSE
      v_paid := v_paid + (r.pool - r.wallet_bounty);
      v_events := v_events + 1;
    END IF;$new$;
  IF length(v_def)-length(replace(v_def,v_old,'')) <> length(v_old) THEN
    RAISE EXCEPTION 'backpay guarded-finalizer substitution did not match exactly once';
  END IF;
  v_def := replace(v_def,v_old,v_new);

  v_old := $old$RETURN jsonb_build_object('ok', true, 'applied', p_apply,
    'events_settled', v_events, 'chips_settled', round(v_paid, 2),$old$;
  v_new := $new$RETURN jsonb_build_object('ok', NOT (p_apply AND v_refused > 0), 'applied', p_apply,
    'events_settled', v_events, 'events_refused', v_refused,
    'chips_settled', round(v_paid, 2),$new$;
  IF length(v_def)-length(replace(v_def,v_old,'')) <> length(v_old) THEN
    RAISE EXCEPTION 'backpay result substitution did not match exactly once';
  END IF;
  EXECUTE replace(v_def,v_old,v_new);
END;
$do$;

-- A full set of current tables is not the same thing as a full tournament.
-- Late registration used to debit/insert and then raise when the seating RPC
-- found no open chair; the exception rolled the whole transaction back, so
-- the manager never saw durable demand and could never expand.  The wrapper
-- below holds the tournament row lock, creates exactly one table by cloning
-- the live table contract, retries registration in the SAME transaction, and
-- emits a durable wake only after charge+roster+seat all commit together.
DO $do$
BEGIN
  IF to_regprocedure(
       'public.fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean)'
     ) IS NULL
     AND to_regprocedure(
       'public.fn_register_for_tournament_before_atomic_lifecycle_gate(uuid,boolean)'
     ) IS NULL THEN
    ALTER FUNCTION public.fn_register_for_tournament(uuid,boolean)
      RENAME TO fn_register_for_tournament_before_atomic_capacity_20260907;
  END IF;
END;
$do$;

CREATE OR REPLACE FUNCTION public.fn_create_late_registration_capacity(
  p_tournament_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_template public.tables%ROWTYPE;
  v_table_id uuid;
  v_table_number integer;
BEGIN
  SELECT * INTO v_t FROM public.tournaments
   WHERE id=p_tournament_id FOR UPDATE;
  IF NOT FOUND OR v_t.status<>'RUNNING' OR COALESCE(v_t.prize_pool_finalized,false) THEN
    RAISE EXCEPTION 'Late-registration capacity is not open' USING ERRCODE='55000';
  END IF;
  IF COALESCE(v_t.late_reg_levels,0)>0 THEN
    IF COALESCE(v_t.current_level,0)>=v_t.late_reg_levels THEN
      RAISE EXCEPTION 'Late-registration capacity is not open' USING ERRCODE='55000';
    END IF;
  ELSIF COALESCE(v_t.late_reg_mins,0)>0 AND v_t.started_at IS NOT NULL THEN
    IF clock_timestamp()>=v_t.started_at+make_interval(mins=>v_t.late_reg_mins) THEN
      RAISE EXCEPTION 'Late-registration capacity is not open' USING ERRCODE='55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'Late-registration capacity is not open' USING ERRCODE='55000';
  END IF;
  IF v_t.max_players IS NOT NULL
     AND COALESCE(v_t.current_players,0)>=v_t.max_players THEN
    RAISE EXCEPTION 'Tournament field is full' USING ERRCODE='55000';
  END IF;

  -- A concurrent registrant may have vacated or created capacity while this
  -- caller waited for the tournament lock. Reuse it instead of over-expanding.
  IF EXISTS (
    SELECT 1 FROM public.tables tb
     WHERE tb.tournament_id=p_tournament_id
       AND tb.status IN ('running','waiting','active')
       AND COALESCE(tb.is_deleted,false)=false
       AND (SELECT count(*) FROM public.table_seats s
             WHERE s.table_id=tb.id AND s.left_at IS NULL)
           < COALESCE(tb.max_players,9)
  ) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_template FROM public.tables tb
   WHERE tb.tournament_id=p_tournament_id
     AND tb.status IN ('running','waiting','active')
     AND COALESCE(tb.is_deleted,false)=false
   ORDER BY tb.created_at DESC,tb.id DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No live tournament table exists to clone safely'
      USING ERRCODE='55000';
  END IF;
  SELECT count(*)+1 INTO v_table_number FROM public.tables
   WHERE tournament_id=p_tournament_id;

  INSERT INTO public.tables(
    club_id,tournament_id,name,game_type,game_variant,stakes,
    small_blind,big_blind,ante,min_buy_in,max_buy_in,max_players,
    current_players,status,action_time_seconds,big_blind_ante_enabled,
    all_in_or_fold
  ) VALUES (
    v_template.club_id,p_tournament_id,
    COALESCE(v_t.name,'Tournament')||' - Table '||v_table_number,
    'tournament',v_template.game_variant,v_template.stakes,
    v_template.small_blind,v_template.big_blind,v_template.ante,
    0,0,v_template.max_players,0,'running',v_template.action_time_seconds,
    v_template.big_blind_ante_enabled,v_template.all_in_or_fold
  ) RETURNING id INTO v_table_id;
  RETURN v_table_id;
END;
$function$;

-- A later lifecycle migration moves this capacity wrapper behind its own
-- public, no-default registration gate. Ordered migration replay must never
-- replace that newer owner or restore this historical DEFAULT false, because
-- doing so bypasses the entry-close receipt and transaction fence. The later
-- capacity migration in the same ordered replay updates the private wrapper.
DO $do$
DECLARE
  v_registration_wrapper text := $definition$
CREATE OR REPLACE FUNCTION public.fn_register_for_tournament(
  p_tournament_id uuid,
  p_seat_first_internal boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  BEGIN
    v_result := public.fn_register_for_tournament_before_atomic_capacity_20260907(
      p_tournament_id,p_seat_first_internal);
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM NOT LIKE 'Late registration could not seat the player (%)%' THEN
      RAISE;
    END IF;
    PERFORM public.fn_create_late_registration_capacity(p_tournament_id);
    v_result := public.fn_register_for_tournament_before_atomic_capacity_20260907(
      p_tournament_id,p_seat_first_internal);
  END;

  IF COALESCE((v_result->>'ok')::boolean,false)
     AND COALESCE((v_result->>'late_registration')::boolean,false) THEN
    PERFORM public.fn_emit_tournament_manager_wake(p_tournament_id,'late_registration');
  END IF;
  RETURN v_result;
END;
$function$;
$definition$;
  v_public regprocedure;
  v_defaults smallint;
BEGIN
  IF to_regprocedure(
       'public.fn_register_for_tournament_before_atomic_lifecycle_gate(uuid,boolean)'
     ) IS NULL THEN
    EXECUTE v_registration_wrapper;
  ELSE
    v_public := to_regprocedure('public.fn_register_for_tournament(uuid,boolean)');
    IF v_public IS NULL THEN
      RAISE EXCEPTION
        'ordered migration replay lost the downstream registration lifecycle gate';
    END IF;
    SELECT p.pronargdefaults INTO v_defaults
      FROM pg_proc p
     WHERE p.oid=v_public;
    IF v_defaults<>0 THEN
      RAISE EXCEPTION
        'ordered migration replay restored a default on the downstream registration lifecycle gate';
    END IF;
  END IF;
END;
$do$;

-- A rebuy/re-entry can arrive while the human decision grace still leaves the
-- just-busted row status='playing'.  The historical money function therefore
-- cannot rely on an eliminated->playing trigger: a re-entry would replace the
-- old generation's head before its knockout debt was durable.  Serialize on
-- the same tournament/player locks as the purchase and require the latest seat
-- generation's bounty obligation to be fully settled before adding/replacing
-- chips on a zero stack.  Non-zero rebuys and add-ons retain their old rules.
CREATE OR REPLACE FUNCTION public.fn_after_tournament_rebuy(
  p_tournament_id uuid,
  p_user_id uuid,
  p_rebuy_type text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  -- The atomic-hand migration replaces this hook in the same transaction that
  -- creates tournament_knockout_candidates. Before that table exists there is
  -- no candidate to close. If the table exists but replacement did not land,
  -- fail the purchase transaction instead of opening a new seat generation
  -- beside an unresolved candidate from the old one.
  IF to_regclass('public.tournament_knockout_candidates') IS NULL THEN
    RETURN;
  END IF;
  RAISE EXCEPTION 'tournament knockout candidate hook is not installed'
    USING ERRCODE='check_violation';
END;
$function$;

DO $do$
BEGIN
  IF to_regprocedure(
       'public.process_tournament_rebuy_before_bounty_guard_20260907(uuid,uuid,text,numeric,numeric,integer,text)'
     ) IS NULL THEN
    ALTER FUNCTION public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)
      RENAME TO process_tournament_rebuy_before_bounty_guard_20260907;
  END IF;
END;
$do$;

CREATE OR REPLACE FUNCTION public.process_tournament_rebuy(
  p_tournament_id uuid,
  p_user_id uuid,
  p_rebuy_type text,
  p_cost numeric,
  p_chips numeric,
  p_current_level integer DEFAULT NULL,
  p_client_token text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_player public.tournament_players%ROWTYPE;
  v_latest_joined_at timestamptz;
  v_result jsonb;
BEGIN
  SELECT * INTO v_t FROM public.tournaments
   WHERE id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;

  SELECT * INTO v_player FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not registered in this tournament'; END IF;

  IF p_rebuy_type IN ('rebuy','reentry','addon')
     AND (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
          OR COALESCE(v_t.is_mystery_bounty,false))
     AND COALESCE(v_player.chips,0) <= 0 THEN
    SELECT s.joined_at INTO v_latest_joined_at
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
     ORDER BY s.joined_at DESC NULLS LAST,s.id DESC
     LIMIT 1;

    IF v_latest_joined_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.tournament_bounty_obligations o
       WHERE o.tournament_id=p_tournament_id
         AND o.eliminated_user_id=p_user_id
         AND o.seat_joined_at=v_latest_joined_at
         AND o.state='settled'
         AND public.fn_bounty_obligation_has_complete_marker(o.id)
    ) THEN
      RAISE EXCEPTION
        'Bounty Settlement Pending - Rebuy Or Re-Entry Cannot Replace This Entry Generation Yet'
        USING ERRCODE='55000';
    END IF;
  END IF;

  IF p_rebuy_type='addon' THEN
    IF COALESCE(v_t.prize_pool_finalized,false)
       OR v_t.addon_period_started_at IS NULL
       OR v_t.addon_period_ends_at IS NULL
       OR clock_timestamp()<v_t.addon_period_started_at
       OR clock_timestamp()>=v_t.addon_period_ends_at THEN
      RAISE EXCEPTION 'Add-On Period Is Closed Or The Prize Pool Is Already Finalized'
        USING ERRCODE='55000';
    END IF;
    -- A zero is a knockout generation, not an add-on target. Waiting for an
    -- outbox is insufficient because the stack/history/claim transaction can
    -- still be between commits; categorically refuse until a rebuy/re-entry
    -- establishes a new positive generation.
    IF COALESCE(v_player.chips,0)<=0 THEN
      RAISE EXCEPTION 'A Zero-Stack Bounty Entry Cannot Take An Add-On'
        USING ERRCODE='55000';
    END IF;
  END IF;

  -- A stone-bubble result is terminal even though its structure prize is
  -- zero. The old core used prize>0 as the terminal proxy and could resurrect
  -- this player immediately after the atomic refund committed.
  IF p_rebuy_type IN ('rebuy','reentry')
     AND v_player.status='eliminated'
     AND EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id=p_tournament_id AND o.kind='bubble_protection'
          AND o.user_id=p_user_id AND o.amount_paid=o.amount_owed
          AND o.amount_paid>0 AND o.settled_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'Bubble Protection Already Paid - This Result Cannot Be Resurrected'
      USING ERRCODE='55000';
  END IF;

  v_result := public.process_tournament_rebuy_before_bounty_guard_20260907(
    p_tournament_id,p_user_id,p_rebuy_type,p_cost,p_chips,p_current_level,p_client_token);
  IF COALESCE((v_result->>'success')::boolean,false)
     AND p_rebuy_type IN ('rebuy','reentry') THEN
    PERFORM public.fn_after_tournament_rebuy(p_tournament_id,p_user_id,p_rebuy_type);
  END IF;
  IF COALESCE((v_result->>'success')::boolean,false)
     AND p_rebuy_type IN ('rebuy','reentry','addon') THEN
    PERFORM public.fn_emit_tournament_manager_wake(p_tournament_id,p_rebuy_type);
  END IF;
  RETURN v_result;
END;
$function$;

-- The add-on purchase and the close both take the same tournament row lock.
-- Whichever commits first defines the boundary: a purchase that owns the lock
-- is included in the pool, while a close that owns it first makes every later
-- purchase refuse.  Guarantee funding happens before the finalized flag is
-- visible, inside this same transaction; pre-setting the flag made the
-- canonical guarantee payer short-circuit without ever funding the overlay.
CREATE OR REPLACE FUNCTION public.fn_close_tournament_addon_period(
  p_tournament_id uuid,
  p_source text DEFAULT 'engine.addon_period_end'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_result jsonb;
  v_final public.tournaments%ROWTYPE;
BEGIN
  SELECT * INTO v_t
    FROM public.tournaments
   WHERE id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','not_found');
  END IF;

  IF COALESCE(v_t.prize_pool_finalized,false) THEN
    RETURN jsonb_build_object(
      'ok',true,
      'already_finalized',true,
      'prize_pool',COALESCE(v_t.prize_pool,0),
      'ends_at',v_t.addon_period_ends_at
    );
  END IF;
  IF v_t.addon_period_started_at IS NULL OR v_t.addon_period_ends_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','addon_period_not_started');
  END IF;
  IF clock_timestamp()<v_t.addon_period_ends_at THEN
    RETURN jsonb_build_object(
      'ok',false,
      'reason','addon_period_open',
      'ends_at',v_t.addon_period_ends_at
    );
  END IF;

  v_result := public.fn_apply_prize_guarantee(
    p_tournament_id,
    COALESCE(NULLIF(btrim(p_source),''),'engine.addon_period_end')
  );
  IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Add-on close could not fund/finalize its prize pool: %',
      COALESCE(v_result->>'reason','unknown') USING ERRCODE='55000';
  END IF;

  SELECT * INTO v_final
    FROM public.tournaments
   WHERE id=p_tournament_id;
  IF COALESCE(v_final.prize_pool_finalized,false) IS NOT TRUE
     OR (v_result->>'prize_pool') IS NULL
     OR round(COALESCE(v_final.prize_pool,0),2)
        <> round((v_result->>'prize_pool')::numeric,2) THEN
    RAISE EXCEPTION 'Add-on close returned without an exact funded pool marker'
      USING ERRCODE='55000';
  END IF;

  RETURN v_result || jsonb_build_object(
    'ok',true,
    'closed',true,
    'ends_at',v_final.addon_period_ends_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.fn_sync_tournament_live_seat_chips(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sync_tournament_live_seat_chips(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric) TO service_role;
REVOKE ALL ON FUNCTION public.fn_close_tournament_addon_period(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_close_tournament_addon_period(uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_create_late_registration_capacity(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_register_for_tournament(uuid,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_register_for_tournament(uuid,boolean) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_collect_bounty_obligation(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_collect_bounty_obligation(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_pay(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_pay(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_sweep_pending_tournament_bounties(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sweep_pending_tournament_bounties(uuid,integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_exact_tournament_knockout_claimants(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_exact_tournament_knockout_claimants(uuid,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_bounty_obligation_has_complete_marker(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bounty_obligation_has_complete_marker(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_tournament_has_unsettled_bounties(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_has_unsettled_bounties(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_finalize_bounty_pool(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_finalize_bounty_pool(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_settle(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_settle(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_final_table_deal(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_final_table_deal(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_emit_tournament_manager_wake(uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_emit_tournament_manager_wake(uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ack_tournament_manager_wakes(uuid,bigint[],bigint[])
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ack_tournament_manager_wakes(uuid,bigint[],bigint[])
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_cast_tournament_deal_vote(uuid)
  FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.fn_cast_tournament_deal_vote(uuid)
  TO authenticated;
REVOKE ALL ON FUNCTION public.fn_after_tournament_rebuy(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_receipt_mystery_activation()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_refuse_mystery_activation_with_pending_heads()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_refuse_reentry_with_pending_bounty()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_refuse_completed_with_pending_bounties()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_retire_manager_wakes_after_terminal_status()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_attach_bounty_ledger_obligation()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_attach_bounty_award_obligation()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ack_bounty_obligation_from_ledger()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ack_bounty_obligation_from_award()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_emit_manager_wake_for_settled_bounty()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_finalize_bounty_pool_unguarded_20260907(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_settle_unguarded_20260907(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_final_table_deal_unguarded_20260907(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_collect_bounty_unguarded_20260907(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_reserve_unguarded_20260907(uuid,uuid,jsonb,uuid,text,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_pay_unguarded_20260907(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.process_tournament_rebuy_before_bounty_guard_20260907(uuid,uuid,text,numeric,numeric,integer,text) FROM PUBLIC,anon,authenticated,service_role;

DO $assert$
BEGIN
  IF has_table_privilege('service_role','public.tournament_bounty_obligations','INSERT')
     OR has_table_privilege('service_role','public.tournament_bounty_obligations','UPDATE')
     OR has_table_privilege('service_role','public.tournament_bounty_obligations','DELETE')
     OR has_table_privilege('service_role','public.tournament_bounty_completion_receipts','INSERT')
     OR has_table_privilege('service_role','public.tournament_bounty_completion_receipts','UPDATE')
     OR has_table_privilege('service_role','public.tournament_bounty_completion_receipts','DELETE')
     OR has_table_privilege('service_role','public.tournament_final_table_deal_receipts','INSERT')
     OR has_table_privilege('service_role','public.tournament_final_table_deal_receipts','UPDATE')
     OR has_table_privilege('service_role','public.tournament_final_table_deal_receipts','DELETE')
     OR has_table_privilege('service_role','public.tournament_mystery_activation_receipts','INSERT')
     OR has_table_privilege('service_role','public.tournament_mystery_activation_receipts','UPDATE')
     OR has_table_privilege('service_role','public.tournament_mystery_activation_receipts','DELETE')
     OR has_table_privilege('service_role','public.tournament_pko_settlement_watermarks','INSERT')
     OR has_table_privilege('service_role','public.tournament_pko_settlement_watermarks','UPDATE')
     OR has_table_privilege('service_role','public.tournament_pko_settlement_watermarks','DELETE')
     OR has_table_privilege('service_role','public.tournament_manager_wakes','INSERT')
     OR has_table_privilege('service_role','public.tournament_manager_wakes','UPDATE')
     OR has_table_privilege('service_role','public.tournament_manager_wakes','DELETE')
     OR has_sequence_privilege('service_role','public.tournament_manager_wakes_id_seq','USAGE') THEN
    RAISE EXCEPTION 'service_role can mutate bounty obligations outside audited RPCs';
  END IF;
  IF has_table_privilege('anon','public.tournament_bounties','INSERT')
     OR has_table_privilege('anon','public.tournament_bounties','UPDATE')
     OR has_table_privilege('authenticated','public.tournament_bounties','INSERT')
     OR has_table_privilege('authenticated','public.tournament_bounties','UPDATE')
     OR has_table_privilege('authenticated','public.tournament_bounties','DELETE')
     OR has_table_privilege('anon','public.tournament_bounty_awards','INSERT')
     OR has_table_privilege('authenticated','public.tournament_bounty_awards','UPDATE')
     OR has_table_privilege('anon','public.tournament_bounty_award_recipients','INSERT')
     OR has_table_privilege('authenticated','public.tournament_bounty_award_recipients','UPDATE')
     OR has_table_privilege('service_role','public.tournament_bounties','INSERT')
     OR has_table_privilege('service_role','public.tournament_bounties','UPDATE')
     OR has_table_privilege('service_role','public.tournament_bounty_awards','INSERT')
     OR has_table_privilege('service_role','public.tournament_bounty_awards','UPDATE')
     OR has_table_privilege('service_role','public.tournament_bounty_award_recipients','INSERT')
     OR has_table_privilege('service_role','public.tournament_bounty_award_recipients','UPDATE') THEN
    RAISE EXCEPTION 'browser roles can forge a bounty payout marker';
  END IF;
  IF has_function_privilege('service_role','public.fn_finalize_bounty_pool_unguarded_20260907(uuid,uuid)','EXECUTE')
     OR has_function_privilege('service_role','public.fn_mystery_bounty_settle_unguarded_20260907(uuid,uuid)','EXECUTE')
     OR has_function_privilege('service_role','public.fn_final_table_deal_unguarded_20260907(uuid)','EXECUTE')
     OR has_function_privilege('service_role','public.fn_collect_bounty_unguarded_20260907(uuid,uuid,uuid,jsonb)','EXECUTE')
     OR has_function_privilege('service_role','public.fn_mystery_bounty_reserve_unguarded_20260907(uuid,uuid,jsonb,uuid,text,uuid,integer)','EXECUTE')
     OR has_function_privilege('service_role','public.fn_mystery_bounty_pay_unguarded_20260907(uuid)','EXECUTE')
     OR has_function_privilege('service_role','public.fn_after_tournament_rebuy(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('service_role','public.process_tournament_rebuy_before_bounty_guard_20260907(uuid,uuid,text,numeric,numeric,integer,text)','EXECUTE') THEN
    RAISE EXCEPTION 'service_role can bypass a bounty/final-deal guard';
  END IF;
  IF has_function_privilege('service_role','public.fn_refuse_reentry_with_pending_bounty()','EXECUTE')
     OR has_function_privilege('service_role','public.fn_refuse_completed_with_pending_bounties()','EXECUTE')
     OR has_function_privilege('service_role','public.fn_retire_manager_wakes_after_terminal_status()','EXECUTE')
     OR has_function_privilege('anon','public.fn_refuse_reentry_with_pending_bounty()','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_refuse_reentry_with_pending_bounty()','EXECUTE')
     OR has_function_privilege('anon','public.fn_refuse_completed_with_pending_bounties()','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_refuse_completed_with_pending_bounties()','EXECUTE')
     OR has_function_privilege('anon','public.fn_retire_manager_wakes_after_terminal_status()','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_retire_manager_wakes_after_terminal_status()','EXECUTE') THEN
    RAISE EXCEPTION 'a trigger-only bounty guard remains directly executable';
  END IF;
  IF has_function_privilege('anon','public.fn_emit_tournament_manager_wake(uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_emit_tournament_manager_wake(uuid,text)','EXECUTE')
     OR has_function_privilege('anon','public.fn_ack_tournament_manager_wakes(uuid,bigint[],bigint[])','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_ack_tournament_manager_wakes(uuid,bigint[],bigint[])','EXECUTE')
     OR has_function_privilege('anon','public.fn_cast_tournament_deal_vote(uuid)','EXECUTE')
     OR has_function_privilege('service_role','public.fn_cast_tournament_deal_vote(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'an untrusted caller can forge a tournament manager wake';
  END IF;
  IF position('bounty_obligation_id' IN pg_get_functiondef(
       'public.fn_collect_bounty(uuid,uuid,uuid,jsonb)'::regprocedure))=0 THEN
    RAISE EXCEPTION 'fn_collect_bounty did not receive generation-aware idempotency';
  END IF;
  IF position('sum(prize)' IN pg_get_functiondef(
       'public.fn_final_table_deal_unguarded_20260907(uuid)'::regprocedure))>0 THEN
    RAISE EXCEPTION 'final-table deal still double-counts the mutable prize cache and payout ledger';
  END IF;
  IF position('mystery_result' IN pg_get_functiondef(
       'public.fn_mystery_bounty_settle(uuid,uuid)'::regprocedure))=0 THEN
    RAISE EXCEPTION 'mystery terminal path has no exact replay receipt';
  END IF;
  IF position('r.paid_at IS NOT NULL' IN pg_get_functiondef(
       'public.fn_bounty_obligation_has_complete_marker(uuid)'::regprocedure))=0 THEN
    RAISE EXCEPTION 'mystery completion does not require paid recipient markers';
  END IF;
  IF to_regprocedure(
       'public.fn_backfill_legacy_tournament_bounty_obligations(uuid,integer)'
     ) IS NOT NULL
     OR to_regprocedure(
       'public.fn_backfill_legacy_tournament_bounty_obligations_page(uuid,integer)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'legacy bounty obligation reconstruction is still callable';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.contype='f'
       AND c.conrelid IN (
         'public.tournament_bounty_obligations'::regclass,
         'public.tournament_bounty_completion_receipts'::regclass,
         'public.tournament_final_table_deal_receipts'::regclass,
         'public.tournament_mystery_activation_receipts'::regclass,
         'public.tournament_pko_settlement_watermarks'::regclass)
       AND c.confrelid IN ('public.tournaments'::regclass,
                          'public.tournament_bounty_obligations'::regclass)
       AND c.confdeltype<>'r'
  ) THEN
    RAISE EXCEPTION 'a bounty audit receipt can still be cascade-deleted';
  END IF;
END;
$assert$;

-- Acquire the explicit trigger-installation lock only after function compilation,
-- grants and invariant assertions have finished. Existing-table DDL above already
-- retains its own locks until COMMIT; the deployment precondition is therefore a
-- drained writer estate, while the 250 ms timeout makes contention fail closed.
-- The complete function/trigger authority switch becomes visible together, so
-- neither old nor new callers can observe half of the financial contract.
LOCK TABLE public.tournament_bounties,
  public.tournament_bounty_awards,
  public.tournament_players,
  public.tournaments
  IN ACCESS EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS trg_attach_bounty_ledger_obligation ON public.tournament_bounties;
CREATE TRIGGER trg_attach_bounty_ledger_obligation
BEFORE INSERT ON public.tournament_bounties
FOR EACH ROW EXECUTE FUNCTION public.fn_attach_bounty_ledger_obligation();

DROP TRIGGER IF EXISTS trg_ack_bounty_obligation_from_ledger ON public.tournament_bounties;
CREATE TRIGGER trg_ack_bounty_obligation_from_ledger
AFTER INSERT ON public.tournament_bounties
FOR EACH ROW EXECUTE FUNCTION public.fn_ack_bounty_obligation_from_ledger();

DROP TRIGGER IF EXISTS trg_attach_bounty_award_obligation ON public.tournament_bounty_awards;
CREATE TRIGGER trg_attach_bounty_award_obligation
BEFORE INSERT ON public.tournament_bounty_awards
FOR EACH ROW EXECUTE FUNCTION public.fn_attach_bounty_award_obligation();

DROP TRIGGER IF EXISTS trg_ack_bounty_obligation_from_award ON public.tournament_bounty_awards;
CREATE TRIGGER trg_ack_bounty_obligation_from_award
AFTER INSERT OR UPDATE OF status ON public.tournament_bounty_awards
FOR EACH ROW EXECUTE FUNCTION public.fn_ack_bounty_obligation_from_award();

DROP TRIGGER IF EXISTS trg_refuse_reentry_with_pending_bounty ON public.tournament_players;
CREATE TRIGGER trg_refuse_reentry_with_pending_bounty
BEFORE UPDATE OF status ON public.tournament_players
FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_reentry_with_pending_bounty();

DROP TRIGGER IF EXISTS trg_refuse_completed_with_pending_bounties ON public.tournaments;
CREATE TRIGGER trg_refuse_completed_with_pending_bounties
BEFORE UPDATE OF status ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_completed_with_pending_bounties();

DROP TRIGGER IF EXISTS trg_retire_manager_wakes_after_terminal_status ON public.tournaments;
CREATE TRIGGER trg_retire_manager_wakes_after_terminal_status
AFTER UPDATE OF status ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_retire_manager_wakes_after_terminal_status();

DROP TRIGGER IF EXISTS trg_refuse_mystery_activation_with_pending_heads ON public.tournaments;
CREATE TRIGGER trg_refuse_mystery_activation_with_pending_heads
BEFORE UPDATE OF mystery_bounty_stage,mystery_bounty_activation_generation ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_mystery_activation_with_pending_heads();

DROP TRIGGER IF EXISTS trg_receipt_mystery_activation ON public.tournaments;
CREATE TRIGGER trg_receipt_mystery_activation
AFTER UPDATE OF mystery_bounty_stage ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_receipt_mystery_activation();

COMMIT;
