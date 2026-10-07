-- DRAFT: run only inside the equivalent, empty-schema preflight container.
-- SQL JWT claims qualify database authorization, NOT GoTrue/PostgREST login.
-- Only synthetic opening-Treasury retirement uses the maintained financial
-- transition. No payout/Promo funding is invoked. All writes roll back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF session_user <> 'leaderboard_qualification_bootstrap'
     OR current_user <> 'leaderboard_qualification_bootstrap'
     OR current_database() <> 'postgres'
     OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'Authorization fixture requires isolated bootstrap socket';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users)
     OR EXISTS (SELECT 1 FROM public.clubs)
     OR EXISTS (SELECT 1 FROM public.unions)
     OR EXISTS (SELECT 1 FROM public.leaderboard_reward_program_versions) THEN
    RAISE EXCEPTION 'Authorization fixture requires empty restored business tables';
  END IF;
END;
$guard$;

INSERT INTO auth.users (id, email, raw_user_meta_data)
SELECT ('90000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'lb-isolated-' || n || '@example.invalid',
       jsonb_build_object('poker_alias', 'IsoLB' || n)
FROM generate_series(1, 5) AS n;

DO $accounts$
BEGIN
  IF (SELECT count(*) FROM public.profiles
      WHERE id IN (SELECT id FROM auth.users)) <> 5 THEN
    RAISE EXCEPTION 'Synthetic signup profile dependency failed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.signup_errors) THEN
    RAISE EXCEPTION 'Synthetic signup trigger dependencies failed';
  END IF;
END;
$accounts$;

-- Actor suffixes: 1 union owner, 2 standalone owner, 3 affiliate owner,
-- 4 ordinary member, 5 nonmember. Union and house club share identity.
-- Synthetic local configuration satisfies the real union-creation allowlist.
-- Independent synthetic limits: two 100000 opening grants and a 100 union
-- issuance fit below 300000. Diamonds remain unused with positive caps.
DO $mint_policy$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_mint_policy) THEN
    RAISE EXCEPTION 'Synthetic Mint policy requires empty isolated configuration';
  END IF;
  INSERT INTO public.ca_mint_policy
    (id, per_operation_cap_chips, rolling_24h_cap_chips,
     per_operation_cap_diamonds, rolling_24h_cap_diamonds, note)
  VALUES (1, 100000, 300000, 1, 1, 'Independent isolated leaderboard fixture limits');
  IF (SELECT count(*) FROM public.ca_mint_policy) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.ca_mint_policy
       WHERE id=1 AND per_operation_cap_chips=100000 AND rolling_24h_cap_chips=300000
         AND per_operation_cap_diamonds=1 AND rolling_24h_cap_diamonds=1
         AND note='Independent isolated leaderboard fixture limits'
         AND updated_at=transaction_timestamp() AND updated_by IS NULL) THEN
    RAISE EXCEPTION 'Synthetic Mint policy exact configuration differs';
  END IF;
END;
$mint_policy$;

INSERT INTO public.union_creators (user_id, note)
VALUES ('90000000-0000-4000-8000-000000000001', 'Isolated authorization fixture');
INSERT INTO public.unions (id, name, owner_id, slug)
VALUES ('91000000-0000-4000-8000-000000000001', 'Isolated Leaderboard Union',
        '90000000-0000-4000-8000-000000000001', 'isolated-leaderboard-union');
INSERT INTO public.clubs (id, name, owner_id, is_union, union_id)
VALUES
 ('91000000-0000-4000-8000-000000000001', 'Isolated Union House',
  '90000000-0000-4000-8000-000000000001', true, NULL),
 ('92000000-0000-4000-8000-000000000001', 'Isolated Affiliate',
  '90000000-0000-4000-8000-000000000003', false, NULL),
 ('92000000-0000-4000-8000-000000000002', 'Isolated Standalone',
  '90000000-0000-4000-8000-000000000002', false, NULL);
-- Ordinary chip clubs receive the maintained opening grant. Retire ONLY this
-- synthetic affiliate's grant through the service-only Mint RPC, preserving
-- its journal, supply registry, operation claim and financial guards.
DO $retire$
DECLARE result jsonb;
BEGIN
  IF (SELECT chip_treasury FROM public.clubs
      WHERE id = '92000000-0000-4000-8000-000000000001') IS DISTINCT FROM 100000 THEN
    RAISE EXCEPTION 'Synthetic affiliate opening-grant preimage changed';
  END IF;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  SET LOCAL ROLE service_role;
  result := public.fn_ca_burn('chips', 'club',
    '92000000-0000-4000-8000-000000000001', 100000,
    'Isolated authorization fixture retires its synthetic opening grant',
    'leaderboard-isolated-authorization:affiliate-opening-retirement', 'seeded');
  IF (result ->> 'ok')::boolean IS DISTINCT FROM true
     OR (result ->> 'balance_after')::numeric IS DISTINCT FROM 0
     OR result ->> 'ledger_id' IS NULL THEN
    RAISE EXCEPTION 'Synthetic opening grant retirement failed';
  END IF;
  RESET ROLE;
END;
$retire$;

-- The intact union-entry guard must accept the now-empty chip club. The
-- maintained mirror trigger establishes clubs.union_id from this relation.
INSERT INTO public.union_clubs (union_id, club_id)
VALUES ('91000000-0000-4000-8000-000000000001',
        '92000000-0000-4000-8000-000000000001');
INSERT INTO public.union_wallets (union_id)
VALUES ('91000000-0000-4000-8000-000000000001')
ON CONFLICT (union_id) DO NOTHING;
-- Use the maintained join RPC; never forge its membership-source GUC.
DO $membership$
DECLARE fixture record; result jsonb;
BEGIN
  FOR fixture IN SELECT * FROM (VALUES
    ('91000000-0000-4000-8000-000000000001'::uuid, '90000000-0000-4000-8000-000000000001'::uuid, 'owner'),
    ('92000000-0000-4000-8000-000000000001'::uuid, '90000000-0000-4000-8000-000000000003'::uuid, 'owner'),
    ('92000000-0000-4000-8000-000000000002'::uuid, '90000000-0000-4000-8000-000000000002'::uuid, 'owner'),
    ('92000000-0000-4000-8000-000000000001'::uuid, '90000000-0000-4000-8000-000000000004'::uuid, 'player'),
    ('92000000-0000-4000-8000-000000000002'::uuid, '90000000-0000-4000-8000-000000000004'::uuid, 'player')
  ) AS fixtures(club_id, user_id, expected_role) LOOP
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', fixture.user_id, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', fixture.user_id::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    SET LOCAL ROLE authenticated;
    result := public.fn_join_club(fixture.club_id);
    IF result ->> 'role' IS DISTINCT FROM fixture.expected_role
       OR COALESCE(result ->> 'status', '') NOT IN ('active', 'approved')
       OR (result ->> 'chip_balance')::numeric IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'Synthetic join did not establish exact zero-chip authority';
    END IF;
    RESET ROLE;
  END LOOP;
END;
$membership$;

DO $matrix$
DECLARE
  actor integer;
  club_suffix integer;
  club uuid;
  identity uuid;
  may_read boolean;
  may_manage boolean;
  refused boolean;
  result jsonb;
  private_field text;
BEGIN
  FOR actor IN 1..5 LOOP
    identity := ('90000000-0000-4000-8000-' || lpad(actor::text, 12, '0'))::uuid;
    FOR club_suffix IN 1..2 LOOP
      club := ('92000000-0000-4000-8000-' || lpad(club_suffix::text, 12, '0'))::uuid;
      may_manage := (actor = 1 AND club_suffix = 1)
                 OR (actor = 2 AND club_suffix = 2);
      may_read := may_manage OR actor = 4 OR (actor = 3 AND club_suffix = 1);
      PERFORM set_config('request.jwt.claims', jsonb_build_object(
        'sub', identity, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', identity::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
      SET LOCAL ROLE authenticated;
      IF current_user <> 'authenticated' OR auth.uid() <> identity THEN
        RAISE EXCEPTION 'Actual SQL role/JWT identity was not established';
      END IF;
      refused := false;
      BEGIN
        result := public.fn_get_leaderboard_reward_setup(club);
      EXCEPTION WHEN insufficient_privilege THEN refused := true;
      END;
      IF refused = may_read THEN
        RAISE EXCEPTION 'Setup read authority mismatch: actor %, club %', actor, club_suffix;
      END IF;
      IF may_read AND (result ->> 'can_manage')::boolean IS DISTINCT FROM may_manage THEN
        RAISE EXCEPTION 'Setup management authority mismatch: actor %, club %', actor, club_suffix;
      END IF;
      IF may_read THEN
        FOREACH private_field IN ARRAY ARRAY[
          'available_balance', 'wallet_balance', 'committed_balance',
          'current_program_commitment', 'other_program_commitments',
          'available_uncommitted_balance', 'publication_capacity', 'committed_club_count'
        ] LOOP
          IF NOT result ? private_field
             OR (NOT may_manage AND result ->> private_field IS NOT NULL) THEN
            RAISE EXCEPTION 'Setup financial privacy contract failed: %', private_field;
          END IF;
        END LOOP;
      END IF;
      refused := false;
      BEGIN
        -- Disabled empty-prize program tests publication authority without funding.
        result := public.fn_save_leaderboard_reward_setup(
          club, false, 'profit', '[]'::jsonb, '[]'::jsonb, 'custom', 0,
          ('93000000-0000-4000-8000-' || lpad((actor * 10 + club_suffix)::text, 12, '0'))::uuid,
          false);
      EXCEPTION WHEN insufficient_privilege THEN refused := true;
      END;
      IF refused = may_manage THEN
        RAISE EXCEPTION 'Setup save authority mismatch: actor %, club %', actor, club_suffix;
      END IF;
      IF may_manage AND (result ->> 'program_version')::integer IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION 'Authorized save did not publish version one';
      END IF;
      RESET ROLE;
    END LOOP;
  END LOOP;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  SET LOCAL ROLE anon;
  refused := false;
  BEGIN
    PERFORM public.fn_get_leaderboard_reward_setup('92000000-0000-4000-8000-000000000001');
  EXCEPTION WHEN insufficient_privilege THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'Anonymous setup read was allowed'; END IF;
  refused := false;
  BEGIN
    PERFORM public.fn_save_leaderboard_reward_setup(
      '92000000-0000-4000-8000-000000000001', false, 'profit', '[]'::jsonb,
      '[]'::jsonb, 'custom', 0, '93000000-0000-4000-8000-000000000099', false);
  EXCEPTION WHEN insufficient_privilege THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'Anonymous setup save was allowed'; END IF;
  RESET ROLE;
END;
$matrix$;

-- No success verdict until real execution and deferred constraint validation.
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
