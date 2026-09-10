\set ON_ERROR_STOP on

DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  status text NOT NULL
);

CREATE TABLE public.tables (
  id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  current_players integer,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.table_seats (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL REFERENCES public.tables(id),
  user_id uuid NOT NULL,
  seat_number integer NOT NULL,
  stack numeric,
  joined_at timestamptz,
  left_at timestamptz,
  status text,
  leave_pending boolean,
  is_sitting_out boolean,
  is_away boolean,
  sit_out_at timestamptz,
  scheduled_leave_hands integer,
  UNIQUE (table_id,seat_number)
);

CREATE TABLE public.tournament_players (
  id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  user_id uuid NOT NULL,
  status text NOT NULL,
  chips integer,
  table_id uuid REFERENCES public.tables(id),
  seat_number integer,
  UNIQUE (tournament_id,user_id)
);

CREATE TABLE public.tournament_knockout_candidates (
  id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  eliminated_user_id uuid NOT NULL,
  table_id uuid NOT NULL REFERENCES public.tables(id),
  seat_id uuid NOT NULL REFERENCES public.table_seats(id),
  seat_joined_at timestamptz NOT NULL,
  hand_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  stack_after numeric NOT NULL,
  state text NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE TABLE public.hand_atomic_commits (
  table_id uuid NOT NULL REFERENCES public.tables(id),
  hand_number bigint NOT NULL,
  hand_id uuid NOT NULL,
  stack_result jsonb NOT NULL,
  committed_at timestamptz NOT NULL,
  PRIMARY KEY (table_id,hand_number),
  UNIQUE (hand_id),
  UNIQUE (hand_number)
);

CREATE TABLE public.settlement_idempotency_keys (
  table_id uuid NOT NULL REFERENCES public.tables(id),
  hand_id uuid NOT NULL,
  status text NOT NULL,
  result jsonb,
  completed_at timestamptz,
  PRIMARY KEY (table_id,hand_id)
);

CREATE TABLE public.tournament_refund_entitlements (
  tournament_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE public.chip_ledger (
  tournament_id uuid,
  from_entity_id uuid,
  category text,
  created_at timestamptz NOT NULL
);

CREATE TABLE public.wallet_transactions (
  related_entity_id uuid,
  user_id uuid,
  type text,
  category text,
  created_at timestamptz NOT NULL
);

CREATE TABLE public.wallet_credit_idempotency (
  user_id uuid,
  key text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE FUNCTION public.fn_ca_has_committed_tournament_receipt(p_tournament_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$
  SELECT false
$function$;

INSERT INTO public.tournaments(id,status)
VALUES ('10000000-0000-4000-8000-000000000001','RUNNING');

INSERT INTO public.tables(id,tournament_id,current_players)
VALUES (
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  CASE WHEN :'scenario'='eligible' THEN 3 ELSE 2 END
);

-- The physical chair rows already carry their later legacy generations. The
-- immutable candidates below retain the earlier zero-generation joined_at.
INSERT INTO public.table_seats(
  id,table_id,user_id,seat_number,stack,joined_at,left_at,status,
  leave_pending,is_sitting_out,is_away,sit_out_at,scheduled_leave_hands
) VALUES
  (
    '40000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',1,115000,
    '2026-09-09 01:01:00+00',NULL,'active',false,false,false,NULL,NULL
  ),
  (
    '40000000-0000-4000-8000-000000000099',
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000099',9,500,
    '2026-09-09 00:30:00+00',NULL,'active',false,false,false,NULL,NULL
  );

INSERT INTO public.table_seats(
  id,table_id,user_id,seat_number,stack,joined_at,left_at,status,
  leave_pending,is_sitting_out,is_away,sit_out_at,scheduled_leave_hands
)
SELECT
  '40000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',2,12000,
  '2026-09-09 01:02:00+00',NULL,'active',false,false,false,NULL,NULL
WHERE :'scenario'='eligible';

INSERT INTO public.tournament_players(
  id,tournament_id,user_id,status,chips,table_id,seat_number
) VALUES
  (
    '50000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001','playing',0,
    '20000000-0000-4000-8000-000000000001',1
  ),
  (
    '50000000-0000-4000-8000-000000000099',
    '10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000099','playing',500,
    '20000000-0000-4000-8000-000000000001',9
  );

INSERT INTO public.tournament_players(
  id,tournament_id,user_id,status,chips,table_id,seat_number
)
SELECT
  '50000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002','playing',0,
  '20000000-0000-4000-8000-000000000001',2
WHERE :'scenario'='eligible';

INSERT INTO public.tournament_knockout_candidates(
  id,tournament_id,eliminated_user_id,table_id,seat_id,seat_joined_at,
  hand_id,hand_number,stack_after,state,resolved_at,created_at
) VALUES (
  '60000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  '2026-09-09 00:55:00+00',
  '70000000-0000-4000-8000-000000000001',1000001,0,'pending',NULL,
  '2026-09-09 01:00:02+00'
);

INSERT INTO public.tournament_knockout_candidates(
  id,tournament_id,eliminated_user_id,table_id,seat_id,seat_joined_at,
  hand_id,hand_number,stack_after,state,resolved_at,created_at
)
SELECT
  '60000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000002',
  '2026-09-09 00:56:00+00',
  '70000000-0000-4000-8000-000000000002',1000002,0,'pending',NULL,
  '2026-09-09 01:00:12+00'
WHERE :'scenario'='eligible';

WITH accepted(table_id,hand_number,hac_hand_id,settlement_hand_id,user_id,
              candidate_created_at,committed_at) AS (
  VALUES
    (
      '20000000-0000-4000-8000-000000000001'::uuid,1000001::bigint,
      '70000000-0000-4000-8000-000000000001'::uuid,
      '80000000-0000-4000-8000-000000000001'::uuid,
      '30000000-0000-4000-8000-000000000001'::uuid,
      '2026-09-09 01:00:02+00'::timestamptz,
      '2026-09-09 01:00:03+00'::timestamptz
    ),
    (
      '20000000-0000-4000-8000-000000000001'::uuid,1000002::bigint,
      '70000000-0000-4000-8000-000000000002'::uuid,
      '80000000-0000-4000-8000-000000000002'::uuid,
      '30000000-0000-4000-8000-000000000002'::uuid,
      '2026-09-09 01:00:12+00'::timestamptz,
      '2026-09-09 01:00:13+00'::timestamptz
    )
), inserted AS (
  INSERT INTO public.hand_atomic_commits(
    table_id,hand_number,hand_id,stack_result,committed_at
  )
  SELECT table_id,hand_number,hac_hand_id,
         jsonb_build_object(
           'success',true,'table_id',table_id::text,
           'hand_id',settlement_hand_id::text,
           'hand_number',hand_number,
           'written',jsonb_build_object(user_id::text,0)),
         committed_at
    FROM accepted
   WHERE hand_number=1000001 OR :'scenario'='eligible'
  RETURNING table_id,hand_number,hand_id,stack_result,committed_at
)
INSERT INTO public.settlement_idempotency_keys(
  table_id,hand_id,status,result,completed_at
)
SELECT i.table_id,a.settlement_hand_id,'succeeded',i.stack_result,
       a.candidate_created_at+interval '500 milliseconds'
  FROM inserted i
  JOIN accepted a USING (table_id,hand_number);

INSERT INTO public.tournament_refund_entitlements(
  tournament_id,user_id,created_at
)
SELECT
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  '2026-09-09 01:01:30+00'
WHERE :'scenario'='funding';

INSERT INTO public.hand_atomic_commits(
  table_id,hand_number,hand_id,stack_result,committed_at
)
SELECT
  '20000000-0000-4000-8000-000000000001',1000100,
  '70000000-0000-4000-8000-000000000100',
  jsonb_build_object(
    'success',true,
    'written',jsonb_build_object(
      '30000000-0000-4000-8000-000000000001',250)),
  '2026-09-09 01:02:30+00'
WHERE :'scenario'='later';
