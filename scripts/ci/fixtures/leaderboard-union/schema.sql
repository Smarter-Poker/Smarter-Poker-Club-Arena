CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid()RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
CREATE FUNCTION auth.role()RETURNS text LANGUAGE sql STABLE AS $$SELECT 'service_role'::text$$;
CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_union_can_manage_wallets(uuid,uuid)RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_leaderboard_prizes_are_valid(jsonb)RETURNS boolean LANGUAGE sql AS $$SELECT jsonb_typeof($1)='array'$$;
CREATE TABLE profiles(id uuid PRIMARY KEY,status text,role text);
CREATE TABLE clubs(id uuid PRIMARY KEY,owner_id uuid,union_id uuid,promo_balance numeric,updated_at timestamptz);
CREATE TABLE unions(id uuid PRIMARY KEY);
CREATE TABLE union_clubs(club_id uuid,union_id uuid,joined_at timestamptz);
CREATE TABLE union_wallets(union_id uuid PRIMARY KEY,promo_wallet numeric,updated_at timestamptz);
CREATE TABLE club_members(user_id uuid,club_id uuid,joined_at timestamptz,role text,chip_balance numeric DEFAULT 0,PRIMARY KEY(user_id,club_id));
CREATE TABLE club_leaderboard_settings(club_id uuid,funding_owner_type text,funding_union_id uuid,updated_at timestamptz);
CREATE TABLE leaderboard_payout_failures(id bigint,club_id uuid,period text,period_start date,error_code text,attempt_count int,first_failed_at timestamptz,failed_at timestamptz,resolved_at timestamptz,resolution text);
CREATE TABLE leaderboard_payouts(id uuid DEFAULT gen_random_uuid(),club_id uuid,period text,metric text,start_date timestamptz,end_date timestamptz,user_id uuid,rank int,payout_amount numeric,payout_currency text,awarded_at timestamptz DEFAULT now(),batch_id uuid,UNIQUE(batch_id,user_id));
CREATE TABLE wallet_credit_idempotency(key text PRIMARY KEY,user_id uuid,amount numeric);
CREATE TABLE fixture_control(fail_user uuid);
INSERT INTO fixture_control VALUES(NULL);
CREATE FUNCTION fn_credit_and_log(uuid,numeric,text,text,text,uuid)RETURNS boolean LANGUAGE plpgsql AS $$BEGIN
 IF $1=(SELECT fail_user FROM fixture_control) THEN RAISE EXCEPTION 'fixture_credit_failure';END IF;
 INSERT INTO wallet_credit_idempotency VALUES($3,$1,$2) ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RETURN false;END IF;
 UPDATE club_members SET chip_balance=chip_balance+$2 WHERE user_id=$1 AND club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';RETURN true;END$$;
CREATE TABLE IF NOT EXISTS public.leaderboard_reward_program_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Raw owner identifiers are retained even if the operational club/union or
  -- publishing profile is later removed. Foreign-key cascades and an
  -- append-only trigger are incompatible: a normal club deletion would be
  -- blocked by the audit table. The publication remains self-contained.
  club_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  operation_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'published' CHECK (status = 'published'),
  rewards_enabled boolean NOT NULL,
  payout_currency text NOT NULL DEFAULT 'chips' CHECK (payout_currency = 'chips'),
  payout_metric text NOT NULL
    CHECK (payout_metric IN ('profit', 'hands_played', 'tournaments_won', 'roi')),
  weekly_prizes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (public.fn_leaderboard_prizes_are_valid(weekly_prizes)),
  monthly_prizes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (public.fn_leaderboard_prizes_are_valid(monthly_prizes)),
  suggestion_key text NOT NULL
    CHECK (suggestion_key IN ('balanced', 'top_heavy', 'even', 'custom')),
  funding_owner_type text NOT NULL CHECK (funding_owner_type IN ('union', 'club')),
  funding_union_id uuid,
  weekly_effective_from date NOT NULL,
  monthly_effective_from date NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid,
  supersedes_program_id uuid REFERENCES public.leaderboard_reward_program_versions(id)
    ON DELETE RESTRICT,
  program_hash text NOT NULL CHECK (program_hash ~ '^[0-9a-f]{32}$'),
  CONSTRAINT leaderboard_reward_program_funding_scope CHECK (
    (funding_owner_type = 'union' AND funding_union_id IS NOT NULL)
    OR (funding_owner_type = 'club' AND funding_union_id IS NULL)
  ),
  CONSTRAINT leaderboard_reward_program_enabled_prizes CHECK (
    NOT rewards_enabled
    OR jsonb_array_length(weekly_prizes) > 0
    OR jsonb_array_length(monthly_prizes) > 0
  ),
  UNIQUE (club_id, version),
  UNIQUE (club_id, operation_id)
);
CREATE TABLE IF NOT EXISTS public.leaderboard_payout_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE RESTRICT,
  period text NOT NULL CHECK (period IN ('weekly', 'monthly')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  metric text NOT NULL,
  program_id uuid NOT NULL REFERENCES public.leaderboard_reward_program_versions(id) ON DELETE RESTRICT,
  program_version integer NOT NULL,
  program_hash text NOT NULL,
  funding_owner_type text NOT NULL CHECK (funding_owner_type IN ('club', 'union')),
  funding_union_id uuid REFERENCES public.unions(id) ON DELETE RESTRICT,
  total_paid numeric(18,2) NOT NULL CHECK (total_paid >= 0),
  seed_funded numeric(18,2) NOT NULL CHECK (seed_funded >= 0),
  promo_funded numeric(18,2) NOT NULL CHECK (promo_funded >= 0),
  overlay_funded numeric(18,2) NOT NULL CHECK (overlay_funded >= 0),
  winner_count integer NOT NULL CHECK (winner_count >= 0),
  settled_at timestamptz NOT NULL DEFAULT now(),
  CHECK (total_paid = seed_funded + promo_funded + overlay_funded),
  CHECK (
    (funding_owner_type = 'club' AND funding_union_id IS NULL)
    OR (funding_owner_type = 'union' AND funding_union_id IS NOT NULL)
  ),
  UNIQUE (club_id, period, period_start)
);
CREATE TABLE public.leaderboard_complete_captures (
  capture_date date PRIMARY KEY,
  captured_at timestamptz NOT NULL,
  capture_timezone text NOT NULL,
  origin text NOT NULL CHECK (origin = 'fn_snapshot_player_stats'),
  source_contract text NOT NULL CHECK (source_contract = 'applied_player_stats_v1'),
  row_count bigint NOT NULL CHECK (row_count >= 0),
  counter_hash text NOT NULL CHECK (counter_hash ~ '^[0-9a-f]{32}$'),
  complete boolean NOT NULL CHECK (complete)
);
CREATE TABLE public.leaderboard_capture_counters (
  snapshot_date date NOT NULL REFERENCES public.leaderboard_complete_captures(capture_date),
  user_id uuid NOT NULL,
  club_id uuid NOT NULL,
  hands_played bigint NOT NULL,
  hands_dealt bigint NOT NULL,
  sum_big_blind numeric NOT NULL,
  total_winnings numeric NOT NULL,
  total_losses numeric NOT NULL,
  total_rake numeric NOT NULL,
  tournaments_played bigint NOT NULL,
  tournaments_won bigint NOT NULL,
  PRIMARY KEY (snapshot_date, club_id, user_id)
);
CREATE TABLE public.leaderboard_basis_rollout (
  singleton boolean PRIMARY KEY CHECK (singleton),
  installed_at timestamptz NOT NULL,
  weekly_v2_from date NOT NULL,
  monthly_v2_from date NOT NULL,
  contract_version text NOT NULL CHECK (contract_version = 'complete_capture_v2'),
  CHECK (extract(dow FROM weekly_v2_from) = 0),
  CHECK (extract(day FROM monthly_v2_from) = 1)
);
CREATE TABLE public.leaderboard_basis_existing_clubs (
  club_id uuid PRIMARY KEY
);
CREATE TABLE public.leaderboard_round_basis_receipts (
  club_id uuid NOT NULL,
  period text NOT NULL CHECK (period IN ('weekly', 'monthly')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  program_id uuid NOT NULL,
  program_version integer NOT NULL CHECK (program_version > 0),
  program_hash text NOT NULL CHECK (program_hash ~ '^[0-9a-f]{32}$'),
  metric text NOT NULL CHECK (metric IN ('profit', 'hands_played', 'tournaments_won', 'roi')),
  basis_version text NOT NULL CHECK (basis_version IN ('legacy_v1', 'complete_capture_v2')),
  basis jsonb NOT NULL CHECK (
    jsonb_typeof(basis) = 'object' AND basis ? 'basis_version' AND basis ? 'complete'
    AND basis ->> 'basis_version' = basis_version
    AND basis -> 'complete' = to_jsonb(basis_version = 'complete_capture_v2')
  ),
  basis_hash text NOT NULL CHECK (basis_hash = md5(basis::text)),
  selected_board jsonb NOT NULL CHECK (jsonb_typeof(selected_board) = 'array'),
  selected_board_hash text NOT NULL CHECK (selected_board_hash = md5(selected_board::text)),
  winners jsonb NOT NULL CHECK (jsonb_typeof(winners) = 'array'),
  winners_hash text NOT NULL CHECK (winners_hash = md5(winners::text)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (club_id, period, period_start),
  CHECK (
    (period = 'weekly' AND extract(dow FROM period_start) = 0
      AND period_end = period_start + 7)
    OR (period = 'monthly' AND extract(day FROM period_start) = 1
      AND period_end = (period_start + interval '1 month')::date)
  )
);
ALTER TABLE leaderboard_reward_program_versions ADD COLUMN overlay_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE leaderboard_payout_batches ADD COLUMN tie_policy text DEFAULT 'split_occupied_places';
INSERT INTO unions VALUES('fade0000-0000-0000-0000-000000000001');
INSERT INTO profiles VALUES('d712fcf0-3741-461d-9617-8cb68fb1c54c','active','member'),('d33a878b-e189-4bd4-aeb8-d9d4acf6cb34','active','member'),('c401b45c-8a60-4480-9900-f452454d77be','active','member'),(md5('fourth')::uuid,'active','member');
INSERT INTO clubs VALUES('2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',md5('owner')::uuid,'fade0000-0000-0000-0000-000000000001',0,now()),(md5('standalone')::uuid,md5('owner')::uuid,NULL,1000,now());
INSERT INTO union_clubs VALUES('2a1132b9-5ba2-42e6-9f01-30a7fcffebe3','fade0000-0000-0000-0000-000000000001','2026-10-12 14:54:29Z');
INSERT INTO club_members(user_id,club_id,joined_at,role) SELECT id,'2a1132b9-5ba2-42e6-9f01-30a7fcffebe3','2026-09-01','member' FROM profiles;
INSERT INTO union_wallets VALUES('fade0000-0000-0000-0000-000000000001',1500,now());
INSERT INTO club_leaderboard_settings VALUES('2a1132b9-5ba2-42e6-9f01-30a7fcffebe3','club',NULL,now());
INSERT INTO leaderboard_reward_program_versions(id,club_id,version,operation_id,rewards_enabled,payout_metric,weekly_prizes,monthly_prizes,suggestion_key,funding_owner_type,weekly_effective_from,monthly_effective_from,published_by,program_hash)
VALUES('cf1e2a57-83f8-4241-977f-5d7b5fd870d6','2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',1,md5('op')::uuid,true,'hands_played','[{"rank":1,"amount":250},{"rank":2,"amount":150},{"rank":3,"amount":100}]','[]','balanced','club','2026-09-06','2026-09-01',NULL,'6cccd5b70afc93983c8419ec15c2f707');
INSERT INTO leaderboard_payout_batches(id,club_id,period,period_start,period_end,metric,program_id,program_version,program_hash,funding_owner_type,total_paid,seed_funded,promo_funded,overlay_funded,winner_count)
VALUES('0b5cebb0-96a4-4163-8d53-2f5f6e482cd2','2a1132b9-5ba2-42e6-9f01-30a7fcffebe3','weekly','2026-10-18','2026-10-25','hands_played','cf1e2a57-83f8-4241-977f-5d7b5fd870d6',1,'6cccd5b70afc93983c8419ec15c2f707','club',0,0,0,0,0);
INSERT INTO leaderboard_basis_rollout VALUES(true,now(),'2026-10-11','2026-10-01','complete_capture_v2');
INSERT INTO leaderboard_complete_captures SELECT d,d::timestamp AT TIME ZONE 'UTC','UTC','fn_snapshot_player_stats','applied_player_stats_v1',0,md5(''),true FROM unnest(ARRAY['2026-10-11'::date,'2026-10-18','2026-10-25','2026-11-01']) d;
INSERT INTO leaderboard_capture_counters
SELECT d.capture_date,p.id,c.club_id,0,
 CASE WHEN c.club_id='fade0000-0000-0000-0000-000000000001' THEN
  (CASE p.id WHEN 'd712fcf0-3741-461d-9617-8cb68fb1c54c' THEN 24786 WHEN 'd33a878b-e189-4bd4-aeb8-d9d4acf6cb34' THEN 22889 WHEN 'c401b45c-8a60-4480-9900-f452454d77be' THEN 22647 ELSE 21460 END)
  *(CASE d.capture_date WHEN '2026-10-25' THEN 1 WHEN '2026-11-01' THEN 2 ELSE 0 END)
 ELSE 100 END,0,0,0,0,0,0
FROM leaderboard_complete_captures d CROSS JOIN profiles p
CROSS JOIN (VALUES('2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid),('fade0000-0000-0000-0000-000000000001'::uuid),(md5('standalone')::uuid)) c(club_id);
UPDATE leaderboard_complete_captures h SET row_count=(SELECT count(*) FROM leaderboard_capture_counters c WHERE c.snapshot_date=h.capture_date),counter_hash=(SELECT md5(string_agg((to_jsonb(c)-'snapshot_date')::text,E'\n' ORDER BY c.club_id,c.user_id)) FROM leaderboard_capture_counters c WHERE c.snapshot_date=h.capture_date);
