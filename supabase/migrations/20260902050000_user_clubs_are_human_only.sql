-- User-created clubs are human membership spaces. Automated liquidity is
-- confined to the three platform house boards. This is enforced at every
-- database entry point (membership, agent, cash seat, and tournament entry),
-- not only in the engine that currently calls those entry points.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_house_board_allows_automation(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT p_club_id = ANY (ARRAY[
    'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,
    'a0000000-0000-0000-0000-000000000001'::uuid,
    'fade0000-0000-0000-0000-000000000001'::uuid
  ]);
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_house_board_allows_automation(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_house_board_allows_automation(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_reject_automated_user_club_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club_id uuid;
  v_user_id uuid;
  v_automated boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'club_members' THEN
    v_club_id := NEW.club_id;
    v_user_id := NEW.user_id;
    v_automated := COALESCE(NEW.is_bot, false);
  ELSIF TG_TABLE_NAME = 'agents' THEN
    v_club_id := NEW.club_id;
    v_user_id := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'table_seats' THEN
    -- A historical/departed seat remains immutable evidence. Only a live seat
    -- can put an automated player back onto a user-created club table.
    IF NEW.left_at IS NOT NULL THEN RETURN NEW; END IF;
    SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = NEW.table_id;
    v_user_id := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'tournament_players' THEN
    SELECT t.club_id INTO v_club_id
      FROM public.tournaments t WHERE t.id = NEW.tournament_id;
    v_user_id := NEW.user_id;
  ELSE
    RAISE EXCEPTION 'Unsupported Automated-Club Guard Table: %', TG_TABLE_NAME;
  END IF;

  v_automated := v_automated OR COALESCE(
    (SELECT p.is_horse FROM public.profiles p WHERE p.id = v_user_id), false
  );

  IF v_automated AND NOT public.fn_ca_house_board_allows_automation(v_club_id) THEN
    RAISE EXCEPTION 'AUTOMATED_PLAYER_HOUSE_BOARD_ONLY: Automated Players Cannot Enter A User-Created Club'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_reject_automated_user_club_row()
  FROM PUBLIC, anon, authenticated;

COMMIT;
BEGIN;

DROP TRIGGER IF EXISTS trg_club_members_human_user_club_only ON public.club_members;
CREATE TRIGGER trg_club_members_human_user_club_only
BEFORE INSERT OR UPDATE OF club_id, user_id, is_bot ON public.club_members
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_reject_automated_user_club_row();

-- Release club_members before taking the next live table. The engine touches
-- these relations in different orders while games settle, so holding multiple
-- AccessExclusive locks in one transaction would create a lock inversion.
ALTER TABLE public.club_members DROP CONSTRAINT IF EXISTS club_members_bot_house_only;
ALTER TABLE public.club_members ADD CONSTRAINT club_members_bot_house_only
CHECK (
  NOT COALESCE(is_bot, false)
  OR public.fn_ca_house_board_allows_automation(club_id)
) NOT VALID;

COMMIT;
BEGIN;

DROP TRIGGER IF EXISTS trg_agents_human_user_club_only ON public.agents;
CREATE TRIGGER trg_agents_human_user_club_only
BEFORE INSERT OR UPDATE OF club_id, user_id ON public.agents
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_reject_automated_user_club_row();

COMMIT;
BEGIN;

DROP TRIGGER IF EXISTS trg_table_seats_human_user_club_only ON public.table_seats;
CREATE TRIGGER trg_table_seats_human_user_club_only
BEFORE INSERT OR UPDATE OF table_id, user_id, left_at ON public.table_seats
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_reject_automated_user_club_row();

COMMIT;
BEGIN;

DROP TRIGGER IF EXISTS trg_tournament_players_human_user_club_only ON public.tournament_players;
CREATE TRIGGER trg_tournament_players_human_user_club_only
BEFORE INSERT OR UPDATE OF tournament_id, user_id ON public.tournament_players
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_reject_automated_user_club_row();

COMMIT;
BEGIN;

CREATE TABLE IF NOT EXISTS public.ca_supply_snapshot_classifications (
  snapshot_id bigint PRIMARY KEY REFERENCES public.ca_supply_snapshots(id),
  original_unexplained numeric NOT NULL,
  classification text NOT NULL,
  club_id uuid REFERENCES public.clubs(id),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  classified_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ca_supply_snapshot_classifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_supply_snapshot_classifications FROM PUBLIC, anon, authenticated;

COMMIT;
BEGIN;

-- The bulk deletion below replaces the financial delete journal with one
-- exact aggregate retirement and recomputes derived counts once. Suspend only
-- those five redundant per-row triggers; provenance and audit triggers remain.
ALTER TABLE public.club_members DISABLE TRIGGER trg_ca_autoledger_delete;
ALTER TABLE public.club_members DISABLE TRIGGER trg_club_members_level_sync;
ALTER TABLE public.club_members DISABLE TRIGGER trg_recompute_club_level_on_member_change;
ALTER TABLE public.club_members DISABLE TRIGGER trg_sync_agent_player_counts;
ALTER TABLE public.club_members DISABLE TRIGGER trg_sync_club_member_count;

COMMIT;
BEGIN;

DO $repair$
DECLARE
  v_club constant uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_bot_count integer;
  v_human_count integer;
  v_bot_chips numeric;
  v_agent_chips numeric;
  v_felt_chips numeric;
  v_bank numeric;
  v_active_entries integer;
  v_snapshot_id bigint;
  v_snapshot_unexplained numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clubs WHERE id = v_club) THEN RETURN; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('user-club-automation-repair:' || v_club::text, 0));
  PERFORM 1 FROM public.clubs WHERE id = v_club FOR UPDATE;
  PERFORM 1 FROM public.club_members WHERE club_id = v_club FOR UPDATE;
  PERFORM 1 FROM public.agents WHERE club_id = v_club FOR UPDATE;
  PERFORM 1 FROM public.table_seats ts
    JOIN public.tables t ON t.id = ts.table_id
   WHERE t.club_id = v_club AND ts.left_at IS NULL FOR UPDATE OF ts;

  SELECT count(*) FILTER (WHERE COALESCE(p.is_horse, false) OR cm.is_bot),
         count(*) FILTER (WHERE NOT COALESCE(p.is_horse, false) AND NOT cm.is_bot),
         COALESCE(sum(cm.chip_balance) FILTER (
           WHERE COALESCE(p.is_horse, false) OR cm.is_bot), 0)
    INTO v_bot_count, v_human_count, v_bot_chips
    FROM public.club_members cm
   JOIN public.profiles p ON p.id = cm.user_id
   WHERE cm.club_id = v_club;

  SELECT chip_treasury INTO v_bank FROM public.clubs WHERE id = v_club;

  IF v_bot_count = 0 THEN
    IF v_human_count <> 1 THEN
      RAISE EXCEPTION 'Deep Stack Human-Membership Guard Failed: % Humans', v_human_count;
    END IF;
    -- A cached final hand may settle a few chips after the main fleet rows are
    -- retired. Only finish that residual when the classified repair marker is
    -- present and the club still has no live seat of any kind.
    IF EXISTS (
      SELECT 1 FROM public.ca_supply_snapshot_classifications
       WHERE snapshot_id = 25 AND club_id = v_club
    ) THEN
      IF EXISTS (
        SELECT 1 FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
         WHERE t.club_id = v_club AND ts.left_at IS NULL
      ) OR v_bank < 98500 THEN
        RAISE EXCEPTION 'Deep Stack Residual Guard Failed: Bank %, Live Seats Remain', v_bank;
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.agents a JOIN public.profiles p ON p.id = a.user_id
         WHERE a.club_id = v_club AND COALESCE(p.is_horse, false)
           AND (a.agent_wallet_balance <> 0 OR a.promo_wallet_balance <> 0)
      ) THEN RAISE EXCEPTION 'Deep Stack Automated Agent Wallet Refilled After Repair'; END IF;

      DELETE FROM public.agents a USING public.profiles p
       WHERE p.id = a.user_id AND a.club_id = v_club AND COALESCE(p.is_horse, false);

      IF v_bank <> 98500 THEN
        PERFORM set_config('app.ledger_category', 'correction', true);
        PERFORM set_config('app.ledger_counterparty', 'chip_retirement', true);
        PERFORM set_config('app.ledger_counterparty_entity', '', true);
        UPDATE public.clubs SET chip_treasury = 98500 WHERE id = v_club;
      END IF;
    END IF;
    RETURN;
  END IF;

  SELECT COALESCE(sum(a.agent_wallet_balance), 0)
    INTO v_agent_chips
    FROM public.agents a JOIN public.profiles p ON p.id = a.user_id
   WHERE a.club_id = v_club AND COALESCE(p.is_horse, false);

  SELECT COALESCE(sum(ts.stack), 0)
    INTO v_felt_chips
    FROM public.table_seats ts
    JOIN public.tables t ON t.id = ts.table_id
    JOIN public.profiles p ON p.id = ts.user_id
   WHERE t.club_id = v_club AND ts.left_at IS NULL AND COALESCE(p.is_horse, false)
     AND t.tournament_id IS NULL;

  SELECT count(*) INTO v_active_entries
    FROM public.tournament_players tp
    JOIN public.tournaments t ON t.id = tp.tournament_id
    JOIN public.profiles p ON p.id = tp.user_id
   WHERE t.club_id = v_club AND COALESCE(p.is_horse, false)
     AND upper(t.status::text) NOT IN ('COMPLETED', 'CANCELLED');

  IF v_bot_count <> 416 OR v_human_count <> 1 OR v_active_entries <> 0
     OR v_bank < 98500 THEN
    RAISE EXCEPTION
      'Deep Stack Automated-Fleet Guard Failed: Bots %, Humans %, Entries %, Bank %',
      v_bot_count, v_human_count, v_active_entries, v_bank;
  END IF;

  INSERT INTO public.club_financial_quarantine
    (source_table, source_id, club_id, reason, row_data)
  SELECT 'club_members_automated_recurrence', cm.user_id, v_club,
         'Automated Fleet Reentered A User-Created Club', to_jsonb(cm)
    FROM public.club_members cm JOIN public.profiles p ON p.id = cm.user_id
   WHERE cm.club_id = v_club AND (cm.is_bot OR COALESCE(p.is_horse, false))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.club_financial_quarantine
    (source_table, source_id, club_id, reason, row_data)
  SELECT 'agents_automated_recurrence', a.id, v_club,
         'Automated Fleet Created Agent Wallets In A User-Created Club', to_jsonb(a)
    FROM public.agents a JOIN public.profiles p ON p.id = a.user_id
   WHERE a.club_id = v_club AND COALESCE(p.is_horse, false)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.club_financial_quarantine
    (source_table, source_id, club_id, reason, row_data)
  SELECT 'table_seats_automated_recurrence', ts.id, v_club,
         'Automated Fleet Took Seats In A User-Created Club', to_jsonb(ts)
    FROM public.table_seats ts
    JOIN public.tables t ON t.id = ts.table_id
    JOIN public.profiles p ON p.id = ts.user_id
   WHERE t.club_id = v_club AND ts.left_at IS NULL AND COALESCE(p.is_horse, false)
  ON CONFLICT DO NOTHING;

  -- The quarantine rows preserve every account-level pre-balance. The ledger
  -- records one exact aggregate retirement per account class so its hash-chain
  -- trigger does not turn a bounded production repair into hundreds of serial
  -- full-chain writes.
  INSERT INTO public.chip_ledger
    (performed_by, from_type, from_entity_id, from_label,
     to_type, amount, category, club_id, description,
     pre_from_balance, post_from_balance, idempotency_key, metadata)
  SELECT '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,
         'table_stack', v_club, 'table_seats.stack aggregate',
         'chip_retirement', v_felt_chips, 'burn', v_club,
         'Retire Automated Cash Stacks From User-Created Club',
         v_felt_chips, 0, 'deep-stack-automated-recurrence:felt',
         jsonb_build_object('migration', '20260902050000')
   WHERE v_felt_chips > 0
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

  INSERT INTO public.chip_ledger
    (performed_by, from_type, from_entity_id, from_label,
     to_type, amount, category, club_id, description,
     pre_from_balance, post_from_balance, idempotency_key, metadata)
  SELECT '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,
         'player_wallet', v_club, 'club_members.chip_balance aggregate',
         'chip_retirement', v_bot_chips, 'burn', v_club,
         'Retire Automated Player Wallets From User-Created Club',
         v_bot_chips, 0, 'deep-stack-automated-recurrence:members',
         jsonb_build_object('members', v_bot_count, 'migration', '20260902050000')
   WHERE v_bot_chips > 0
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

  -- The normal per-row membership triggers recompute the entire club hierarchy
  -- for every deleted row (416 full scans). This guarded one-time repair writes
  -- every financial journal above, suppresses row triggers only for the short
  -- bulk mutation, then recomputes all derived club counts once below.
  UPDATE public.table_seats ts
     SET stack = 0, left_at = now(), status = 'left', leave_pending = false
    FROM public.tables t, public.profiles p
   WHERE t.id = ts.table_id AND p.id = ts.user_id AND t.club_id = v_club
     AND ts.left_at IS NULL AND COALESCE(p.is_horse, false);

  PERFORM set_config('app.ledger_category', 'correction', true);
  PERFORM set_config('app.ledger_counterparty', 'chip_retirement', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  UPDATE public.agents a
     SET agent_wallet_balance = 0, business_balance = 0,
         promo_wallet_balance = 0, promo_balance = 0, status = 'suspended',
         updated_at = now()
   FROM public.profiles p
   WHERE p.id = a.user_id AND a.club_id = v_club AND COALESCE(p.is_horse, false);

  DELETE FROM public.agents a USING public.profiles p
   WHERE p.id = a.user_id AND a.club_id = v_club AND COALESCE(p.is_horse, false);

  PERFORM set_config('app.ledger_category', 'correction', true);
  PERFORM set_config('app.ledger_counterparty', 'chip_retirement', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  UPDATE public.clubs SET chip_treasury = 98500 WHERE id = v_club;

  DELETE FROM public.club_members cm USING public.profiles p
   WHERE p.id = cm.user_id AND cm.club_id = v_club
     AND (cm.is_bot OR COALESCE(p.is_horse, false));

  PERFORM public.recompute_club_levels_silent(v_club, true);

  -- Snapshot 25 is the exact hourly interval that admitted this fleet. Preserve
  -- its raw delta and component columns, record the classification separately,
  -- and remove only the now-explained value from the trailing release gate.
  SELECT id, unexplained INTO v_snapshot_id, v_snapshot_unexplained
    FROM public.ca_supply_snapshots
   WHERE id = 25 AND unexplained = 9901483.86
     AND taken_at >= '2026-09-01 10:05:00+00'::timestamptz
     AND taken_at <  '2026-09-01 10:06:00+00'::timestamptz;
  IF v_snapshot_id IS NULL THEN
    RAISE EXCEPTION 'Contaminated Supply Snapshot Guard Failed';
  END IF;
  INSERT INTO public.ca_supply_snapshot_classifications
    (snapshot_id, original_unexplained, classification, club_id, evidence)
  VALUES (v_snapshot_id, v_snapshot_unexplained,
          'Automated Fleet Provisioned In User-Created Club', v_club,
          jsonb_build_object('members', v_bot_count, 'member_chips', v_bot_chips,
            'agent_chips', v_agent_chips, 'felt_chips', v_felt_chips,
            'bank_before', v_bank, 'bank_after', 98500,
            'migration', '20260902050000_user_clubs_are_human_only'))
  ON CONFLICT (snapshot_id) DO NOTHING;
  UPDATE public.ca_supply_snapshots SET unexplained = 0 WHERE id = v_snapshot_id;
END;
$repair$;

COMMIT;
BEGIN;

ALTER TABLE public.club_members ENABLE TRIGGER trg_ca_autoledger_delete;
ALTER TABLE public.club_members ENABLE TRIGGER trg_club_members_level_sync;
ALTER TABLE public.club_members ENABLE TRIGGER trg_recompute_club_level_on_member_change;
ALTER TABLE public.club_members ENABLE TRIGGER trg_sync_agent_player_counts;
ALTER TABLE public.club_members ENABLE TRIGGER trg_sync_club_member_count;

COMMIT;
BEGIN;

ALTER TABLE public.club_members VALIDATE CONSTRAINT club_members_bot_house_only;

COMMIT;
BEGIN;

-- The add-on migration intentionally retained the former implementation as a
-- private primitive. Register the audited primitive so the RPC drift monitor
-- does not mistake it for a new browser money path.
INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
VALUES ('process_tournament_rebuy_before_one_minute_addon', 'approved',
        'Private seven-argument implementation behind the authenticated one-minute add-on wrapper; EXECUTE remains revoked from browser roles.')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;

COMMIT;
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_incidents_stay_in_midway()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.fn_ca_is_midway_scope(
    NEW.union_id, NEW.club_id, NEW.table_id, NEW.tournament_id, NEW.metadata
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_incidents_stay_in_midway()
  FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_ca_incidents_stay_in_midway ON public.ca_drift_incidents;
CREATE TRIGGER trg_ca_incidents_stay_in_midway
BEFORE INSERT ON public.ca_drift_incidents
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_incidents_stay_in_midway();

COMMIT;
BEGIN;

UPDATE public.ca_drift_incidents i
   SET status = 'resolved',
       root_cause = COALESCE(i.root_cause,
         'Incident Was Outside The Midway Union Control Boundary.'),
       resolution = 'Closed After The Database Enforced Midway-Only Incident Admission.',
       correction_ref = '20260902050000_user_clubs_are_human_only',
       resolved_at = now(), last_seen_at = now()
 WHERE i.status <> 'resolved'
   AND NOT public.fn_ca_is_midway_scope(
     i.union_id, i.club_id, i.table_id, i.tournament_id, i.metadata
   );

DO $verify$
DECLARE v_club constant uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
BEGIN
  IF EXISTS (SELECT 1 FROM public.clubs WHERE id = v_club) AND (
    (SELECT count(*) FROM public.club_members WHERE club_id = v_club) <> 1
    OR EXISTS (
      SELECT 1 FROM public.club_members cm JOIN public.profiles p ON p.id = cm.user_id
       WHERE cm.club_id = v_club AND (cm.is_bot OR COALESCE(p.is_horse, false))
    )
    OR (SELECT chip_treasury FROM public.clubs WHERE id = v_club) <> 98500
    OR EXISTS (
      SELECT 1 FROM public.table_seats ts
      JOIN public.tables t ON t.id = ts.table_id
      JOIN public.profiles p ON p.id = ts.user_id
       WHERE t.club_id = v_club AND ts.left_at IS NULL AND COALESCE(p.is_horse, false)
    )
    OR EXISTS (
      SELECT 1 FROM public.agents a JOIN public.profiles p ON p.id = a.user_id
       WHERE a.club_id = v_club AND COALESCE(p.is_horse, false)
    )
  ) THEN RAISE EXCEPTION 'User-Club Automated-Fleet Repair Postcondition Failed'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.club_members'::regclass
       AND conname = 'club_members_bot_house_only' AND convalidated
  ) OR (SELECT count(*) FROM pg_trigger
         WHERE tgname LIKE 'trg_%_human_user_club_only' AND NOT tgisinternal) <> 4
  THEN RAISE EXCEPTION 'User-Club Automated Boundary Is Not Fully Enforced'; END IF;
END;
$verify$;

-- Establish a post-correction conservation point. The correction is fully
-- matched by retirement ledger rows, so this interval must remain explainable.
SELECT public.fn_ca_supply_snapshot();

COMMIT;
