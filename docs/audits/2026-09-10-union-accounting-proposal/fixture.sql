CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE public.agents(id uuid PRIMARY KEY,user_id uuid,club_id uuid,commission_rate numeric,
 parent_agent_id uuid,role text,status text DEFAULT 'active',weekly_rake_generated numeric DEFAULT 0,
 lifetime_rake_generated numeric DEFAULT 0,last_active_at timestamptz,updated_at timestamptz);
CREATE TABLE public.club_members(user_id uuid,club_id uuid,agent_id uuid,joined_at timestamptz DEFAULT now(),PRIMARY KEY(user_id,club_id));
CREATE TABLE public.clubs(id uuid PRIMARY KEY,union_id uuid,owner_id uuid);
CREATE TABLE public.union_clubs(club_id uuid,union_id uuid);
CREATE TABLE public.table_seats(table_id uuid,user_id uuid,club_id uuid,left_at timestamptz);
INSERT INTO public.clubs(id) VALUES('00000000-0000-4000-8000-000000000900'),('00000000-0000-4000-8000-000000000901'),('00000000-0000-4000-8000-000000000903');
CREATE TABLE public.agent_commissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid NOT NULL,
 user_id uuid NOT NULL,amount numeric,commission_rate numeric,source_type text,source_id uuid,notes text,
 created_at timestamptz DEFAULT now(),settled_at timestamptz);
CREATE UNIQUE INDEX uq_agent_commissions_source ON public.agent_commissions(user_id,source_id,source_type) WHERE source_id IS NOT NULL;
CREATE TABLE public.test_alerts(id uuid DEFAULT gen_random_uuid(),severity text,source text,context jsonb,dedupe_key text UNIQUE);
CREATE FUNCTION public.fn_resolve_player_club_for_agent(uuid,uuid,uuid) RETURNS uuid LANGUAGE sql AS 'SELECT $2';
CREATE FUNCTION public.fn_raise_server_financial_alert(text,text,text,jsonb,text) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_id uuid;
BEGIN
 INSERT INTO test_alerts(severity,source,context,dedupe_key) VALUES($1,$2,$4,$5) ON CONFLICT(dedupe_key) DO UPDATE SET context=excluded.context RETURNING id INTO v_id;
 RETURN v_id;
END $f$;
-- Synthetic fixtures only, never production identifiers.
INSERT INTO agents(id,user_id,club_id,commission_rate,parent_agent_id,role) VALUES
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000900',.25,'00000000-0000-4000-8000-000000000002','sub_agent'),
 ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000900',.50,'00000000-0000-4000-8000-000000000003','agent'),
 ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000900',.70,NULL,'super_agent'),
 ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000901',.50,NULL,'agent');
INSERT INTO club_members(user_id,club_id,agent_id) VALUES
 ('00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000900','00000000-0000-4000-8000-000000000101'),
 ('00000000-0000-4000-8000-000000000202','00000000-0000-4000-8000-000000000900','00000000-0000-4000-8000-000000000101');
CREATE OR REPLACE FUNCTION public.credit_agent_commission_from_rake(p_agent_user_id uuid, p_club_id uuid, p_rake_credit numeric, p_source_type text DEFAULT 'rake_settlement'::text, p_source_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_id          UUID;
  v_agent_user_id     UUID;
  v_commission_rate   NUMERIC;
  v_parent_agent_id   UUID;
  v_parent_user_id    UUID;
  v_parent_rate       NUMERIC;
  v_direct_commission NUMERIC;
  v_parent_commission NUMERIC;
  v_remaining         NUMERIC;
  v_book_club         UUID;
  v_inserted_direct   INTEGER := 0;
BEGIN
  -- UNION LAW: the agent follows the PLAYER's club, not the table's club.
  v_book_club := public.fn_resolve_player_club_for_agent(p_agent_user_id, p_club_id, NULL);

  SELECT a.id, a.user_id, a.commission_rate, a.parent_agent_id
    INTO v_agent_id, v_agent_user_id, v_commission_rate, v_parent_agent_id
    FROM club_members cm
    JOIN agents a ON a.user_id = cm.agent_id AND a.club_id = cm.club_id AND a.status = 'active'
   WHERE cm.user_id = p_agent_user_id AND cm.club_id = v_book_club
   LIMIT 1;

  -- The caller may itself be an agent generating rake.
  IF v_agent_id IS NULL THEN
    SELECT id, user_id, commission_rate, parent_agent_id
      INTO v_agent_id, v_agent_user_id, v_commission_rate, v_parent_agent_id
      FROM agents WHERE user_id = p_agent_user_id AND status = 'active'
     ORDER BY (club_id = v_book_club) DESC
     LIMIT 1;
  END IF;

  IF v_agent_id IS NULL THEN RETURN; END IF;

  -- Idempotency is per AGENT and source, never per source alone: a hand has
  -- one row per agent in the chain of every contributing player, and only a
  -- retry for the same agent returns here (Chip Standard P4, lane 2.2).
  IF p_source_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM agent_commissions
     WHERE source_id = p_source_id AND source_type = p_source_type
       AND user_id = v_agent_user_id
     LIMIT 1
  ) THEN
    RETURN;
  END IF;

  v_direct_commission := ROUND(p_rake_credit * COALESCE(v_commission_rate, 0), 2);
  v_remaining         := p_rake_credit - v_direct_commission;

  IF v_direct_commission > 0 THEN
    INSERT INTO agent_commissions (
      club_id, user_id, amount, commission_rate, source_type, source_id, notes
    ) VALUES (
      COALESCE(v_book_club, p_club_id), v_agent_user_id, v_direct_commission, v_commission_rate,
      p_source_type, p_source_id, COALESCE(p_notes, 'agent slice (accrual)')
    )
    ON CONFLICT (user_id, source_id, source_type) WHERE source_id IS NOT NULL
    DO NOTHING;
    GET DIAGNOSTICS v_inserted_direct = ROW_COUNT;

    IF v_inserted_direct > 0 THEN
      UPDATE agents SET
        weekly_rake_generated   = COALESCE(weekly_rake_generated, 0)   + p_rake_credit,
        lifetime_rake_generated = COALESCE(lifetime_rake_generated, 0) + p_rake_credit,
        last_active_at          = NOW(),
        updated_at              = NOW()
      WHERE id = v_agent_id;
    END IF;
  END IF;

  -- Super-agent override on the downstream volume (PokerBros model).
  IF v_parent_agent_id IS NOT NULL AND v_remaining > 0 THEN
    SELECT id, user_id, commission_rate
      INTO v_parent_agent_id, v_parent_user_id, v_parent_rate
      FROM agents WHERE id = v_parent_agent_id AND status = 'active'
     LIMIT 1;

    IF v_parent_agent_id IS NOT NULL AND v_parent_rate IS NOT NULL THEN
      v_parent_commission := ROUND(v_remaining * v_parent_rate, 2);
      IF v_parent_commission > 0 THEN
        INSERT INTO agent_commissions (
          club_id, user_id, amount, commission_rate, source_type, source_id, notes
        ) VALUES (
          COALESCE(v_book_club, p_club_id), v_parent_user_id, v_parent_commission, v_parent_rate,
          p_source_type, p_source_id, 'super-agent slice (accrual)'
        )
        ON CONFLICT (user_id, source_id, source_type) WHERE source_id IS NOT NULL
        DO NOTHING;
      END IF;
    END IF;
  END IF;
END;
$function$;
