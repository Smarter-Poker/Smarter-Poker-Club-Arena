-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419182343 "phase26cd_escrow_and_disputes"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b14c2d480b87b0d530e06deed26faea1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 26 PART C + D — Escrow data model + dispute system
--  DATA MODEL ONLY — no actual money handling. Serves as the DB substrate
--  for future Stripe/Paypal/etc. integration.
-- =========================================================================

-- ════════════════════════════════════════════════════════════════════════
-- Per-game escrow account
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS commander_home_game_escrow (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id              uuid NOT NULL UNIQUE REFERENCES commander_home_games(id) ON DELETE RESTRICT,
    group_id             uuid NOT NULL REFERENCES commander_home_groups(id) ON DELETE RESTRICT,
    host_id              uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
    buy_in_amount        numeric(10,2) NOT NULL CHECK (buy_in_amount >= 0),
    rake_pct             numeric(5,2) DEFAULT 0 CHECK (rake_pct >= 0 AND rake_pct <= 10),
    rake_cap             numeric(10,2),  -- optional cap on rake per game
    platform_fee_pct     numeric(5,2) DEFAULT 0 CHECK (platform_fee_pct >= 0 AND platform_fee_pct <= 5),
    currency             text NOT NULL DEFAULT 'USD',
    status               text NOT NULL DEFAULT 'initialized' 
                            CHECK (status IN (
                                'initialized',    -- created, no contributions yet
                                'collecting',     -- taking buy-ins
                                'in_play',        -- game started, no more buy-ins
                                'settling',       -- payouts being computed/executed
                                'settled',        -- all paid out
                                'refunded',       -- game cancelled, all buy-ins refunded
                                'disputed',       -- disputed, frozen
                                'cancelled'
                            )),
    collected_total      numeric(12,2) NOT NULL DEFAULT 0,
    settled_total        numeric(12,2) NOT NULL DEFAULT 0,
    host_payout_total    numeric(12,2) NOT NULL DEFAULT 0,
    platform_fee_total   numeric(12,2) NOT NULL DEFAULT 0,
    collection_opened_at timestamptz,
    collection_closed_at timestamptz,
    settled_at           timestamptz,
    created_at           timestamptz NOT NULL DEFAULT NOW(),
    updated_at           timestamptz NOT NULL DEFAULT NOW(),
    notes                text
);

CREATE INDEX idx_escrow_group_status ON commander_home_game_escrow(group_id, status);
CREATE INDEX idx_escrow_host ON commander_home_game_escrow(host_id, created_at DESC);

ALTER TABLE commander_home_game_escrow ENABLE ROW LEVEL SECURITY;

-- Host sees their own escrow; approved game participants can see their own game's escrow
CREATE POLICY escrow_host_select ON commander_home_game_escrow
  FOR SELECT TO authenticated USING (
    host_id = auth.uid()
    OR group_id IN (SELECT group_id FROM commander_home_members 
                     WHERE user_id = auth.uid() AND status='approved' AND role IN ('owner','admin'))
    OR game_id IN (SELECT game_id FROM commander_home_rsvps WHERE user_id = auth.uid() AND response='yes')
  );

-- ════════════════════════════════════════════════════════════════════════
-- Individual buy-in contributions
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS commander_home_game_escrow_contributions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    escrow_id         uuid NOT NULL REFERENCES commander_home_game_escrow(id) ON DELETE CASCADE,
    user_id           uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
    amount            numeric(10,2) NOT NULL CHECK (amount > 0),
    rebuy_number      int DEFAULT 0 CHECK (rebuy_number >= 0),  -- 0 = initial buy-in, 1+ = rebuys
    payment_method    text CHECK (payment_method IN ('cash','venmo','zelle','paypal','stripe','cashapp','apple_pay','google_pay','other','in_app')),
    payment_reference text,  -- external txn ID (stripe pi_xxx, venmo note, etc.)
    status            text NOT NULL DEFAULT 'pending' 
                        CHECK (status IN ('pending','confirmed','refunded','disputed','failed')),
    contributed_at    timestamptz NOT NULL DEFAULT NOW(),
    confirmed_at      timestamptz,
    refunded_at       timestamptz,
    notes             text
);

CREATE INDEX idx_escrow_contrib_escrow ON commander_home_game_escrow_contributions(escrow_id, status);
CREATE INDEX idx_escrow_contrib_user ON commander_home_game_escrow_contributions(user_id, contributed_at DESC);

ALTER TABLE commander_home_game_escrow_contributions ENABLE ROW LEVEL SECURITY;

-- User sees own contributions; host sees all contributions for their escrows
CREATE POLICY escrow_contrib_own_select ON commander_home_game_escrow_contributions
  FOR SELECT TO authenticated USING (
    user_id = auth.uid()
    OR escrow_id IN (SELECT id FROM commander_home_game_escrow WHERE host_id = auth.uid())
    OR escrow_id IN (SELECT id FROM commander_home_game_escrow e
                      WHERE e.group_id IN (SELECT group_id FROM commander_home_members 
                                            WHERE user_id = auth.uid() AND status='approved' 
                                              AND role IN ('owner','admin')))
  );

-- ════════════════════════════════════════════════════════════════════════
-- Settlements (payouts at end of game)
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS commander_home_game_escrow_settlements (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    escrow_id         uuid NOT NULL REFERENCES commander_home_game_escrow(id) ON DELETE CASCADE,
    user_id           uuid REFERENCES profiles(id) ON DELETE SET NULL,  -- NULL = platform/host
    payee_type        text NOT NULL CHECK (payee_type IN ('player','host','platform','rake')),
    amount            numeric(10,2) NOT NULL,  -- positive = payout to user; can be negative for fees
    finish_position   int,       -- for tournaments
    finish_note       text,      -- for cash games e.g. "cashed out +$45"
    payment_method    text,
    payment_reference text,
    status            text NOT NULL DEFAULT 'pending' 
                        CHECK (status IN ('pending','paid','reversed','disputed','failed')),
    settled_at        timestamptz NOT NULL DEFAULT NOW(),
    paid_at           timestamptz,
    notes             text
);

CREATE INDEX idx_escrow_settle_escrow ON commander_home_game_escrow_settlements(escrow_id, status);
CREATE INDEX idx_escrow_settle_user ON commander_home_game_escrow_settlements(user_id, settled_at DESC);

ALTER TABLE commander_home_game_escrow_settlements ENABLE ROW LEVEL SECURITY;

CREATE POLICY escrow_settle_select ON commander_home_game_escrow_settlements
  FOR SELECT TO authenticated USING (
    user_id = auth.uid()
    OR escrow_id IN (SELECT id FROM commander_home_game_escrow WHERE host_id = auth.uid())
    OR escrow_id IN (SELECT id FROM commander_home_game_escrow e
                      WHERE e.group_id IN (SELECT group_id FROM commander_home_members 
                                            WHERE user_id = auth.uid() AND status='approved' 
                                              AND role IN ('owner','admin')))
  );

-- ════════════════════════════════════════════════════════════════════════
-- Contribution + settlement counter sync trigger
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_sync_escrow_counters()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_escrow_id uuid;
BEGIN
    v_escrow_id := COALESCE(NEW.escrow_id, OLD.escrow_id);
    UPDATE commander_home_game_escrow
       SET collected_total = COALESCE((
              SELECT SUM(amount) FROM commander_home_game_escrow_contributions 
               WHERE escrow_id = v_escrow_id AND status = 'confirmed'), 0),
           settled_total = COALESCE((
              SELECT SUM(amount) FROM commander_home_game_escrow_settlements 
               WHERE escrow_id = v_escrow_id AND status = 'paid' AND payee_type = 'player'), 0),
           host_payout_total = COALESCE((
              SELECT SUM(amount) FROM commander_home_game_escrow_settlements 
               WHERE escrow_id = v_escrow_id AND status = 'paid' AND payee_type = 'host'), 0),
           platform_fee_total = COALESCE((
              SELECT SUM(amount) FROM commander_home_game_escrow_settlements 
               WHERE escrow_id = v_escrow_id AND status = 'paid' AND payee_type IN ('platform','rake')), 0),
           updated_at = NOW()
     WHERE id = v_escrow_id;
    RETURN COALESCE(NEW, OLD);
END; $fn$;

CREATE TRIGGER trg_sync_escrow_from_contributions
    AFTER INSERT OR UPDATE OR DELETE ON commander_home_game_escrow_contributions
    FOR EACH ROW EXECUTE FUNCTION public.fn_sync_escrow_counters();

CREATE TRIGGER trg_sync_escrow_from_settlements
    AFTER INSERT OR UPDATE OR DELETE ON commander_home_game_escrow_settlements
    FOR EACH ROW EXECUTE FUNCTION public.fn_sync_escrow_counters();

-- ════════════════════════════════════════════════════════════════════════
-- Escrow RPCs
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.create_home_game_escrow(
    p_game_id         uuid,
    p_caller_user_id  uuid,
    p_buy_in_amount   numeric,
    p_rake_pct        numeric DEFAULT 0,
    p_platform_fee_pct numeric DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_game RECORD; v_group RECORD; v_id uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_buy_in_amount < 0 THEN RAISE EXCEPTION 'INVALID_BUY_IN'; END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    IF v_game.host_id <> p_caller_user_id AND v_group.owner_id <> p_caller_user_id THEN
        RAISE EXCEPTION 'NOT_AUTHORIZED';
    END IF;

    INSERT INTO commander_home_game_escrow (
        game_id, group_id, host_id, buy_in_amount, rake_pct, platform_fee_pct, status, collection_opened_at
    ) VALUES (
        p_game_id, v_game.group_id, COALESCE(v_game.host_id, v_group.owner_id), 
        p_buy_in_amount, p_rake_pct, p_platform_fee_pct, 'collecting', NOW()
    ) RETURNING id INTO v_id;

    RETURN jsonb_build_object('success', true, 'escrow_id', v_id, 'status', 'collecting');
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.create_home_game_escrow(uuid, uuid, numeric, numeric, numeric) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_home_game_escrow(uuid, uuid, numeric, numeric, numeric) TO authenticated, service_role;

-- Record a buy-in
CREATE OR REPLACE FUNCTION public.record_escrow_contribution(
    p_escrow_id       uuid,
    p_user_id         uuid,
    p_amount          numeric,
    p_caller_user_id  uuid,  -- host recording (or self for in_app payment)
    p_payment_method  text DEFAULT 'cash',
    p_payment_ref     text DEFAULT NULL,
    p_rebuy_number    int DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_escrow RECORD; v_id uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_amount <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;

    SELECT * INTO v_escrow FROM commander_home_game_escrow WHERE id = p_escrow_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ESCROW_NOT_FOUND'; END IF;
    IF v_escrow.status NOT IN ('collecting','in_play') THEN 
        RAISE EXCEPTION 'ESCROW_NOT_ACCEPTING_CONTRIBUTIONS' USING HINT='status=' || v_escrow.status; 
    END IF;

    -- Host records contributions, OR self can record own (in_app payment flow)
    IF v_escrow.host_id <> p_caller_user_id AND p_user_id <> p_caller_user_id THEN
        RAISE EXCEPTION 'NOT_AUTHORIZED';
    END IF;

    INSERT INTO commander_home_game_escrow_contributions (
        escrow_id, user_id, amount, rebuy_number,
        payment_method, payment_reference, 
        status, confirmed_at
    ) VALUES (
        p_escrow_id, p_user_id, p_amount, p_rebuy_number,
        p_payment_method, p_payment_ref,
        CASE WHEN p_payment_method = 'cash' THEN 'confirmed'  -- host verifies cash in person
             WHEN p_payment_method = 'in_app' THEN 'confirmed'  -- Stripe/etc webhook will confirm
             ELSE 'pending' END,
        CASE WHEN p_payment_method IN ('cash','in_app') THEN NOW() ELSE NULL END
    ) RETURNING id INTO v_id;

    RETURN jsonb_build_object('success', true, 'contribution_id', v_id);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.record_escrow_contribution(uuid, uuid, numeric, uuid, text, text, int) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.record_escrow_contribution(uuid, uuid, numeric, uuid, text, text, int) TO authenticated, service_role;

-- Lock escrow for settlement (no more buy-ins)
CREATE OR REPLACE FUNCTION public.transition_escrow_status(
    p_escrow_id       uuid,
    p_new_status      text,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE 
    v_escrow RECORD; 
    v_allowed jsonb := jsonb_build_object(
        'initialized', jsonb_build_array('collecting','cancelled'),
        'collecting', jsonb_build_array('in_play','cancelled','disputed'),
        'in_play', jsonb_build_array('settling','disputed','cancelled'),
        'settling', jsonb_build_array('settled','disputed'),
        'settled', jsonb_build_array('disputed'),
        'disputed', jsonb_build_array('settled','cancelled','refunded'),
        'cancelled', jsonb_build_array(),
        'refunded', jsonb_build_array()
    );
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_escrow FROM commander_home_game_escrow WHERE id = p_escrow_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ESCROW_NOT_FOUND'; END IF;
    IF v_escrow.host_id <> p_caller_user_id THEN RAISE EXCEPTION 'NOT_HOST'; END IF;

    -- Check valid transition
    IF NOT (v_allowed->v_escrow.status ? p_new_status) THEN
        RAISE EXCEPTION 'INVALID_TRANSITION' USING HINT='cannot go from '||v_escrow.status||' to '||p_new_status;
    END IF;

    UPDATE commander_home_game_escrow 
       SET status = p_new_status,
           collection_closed_at = CASE WHEN p_new_status IN ('in_play','settling','settled','cancelled') 
                                       THEN COALESCE(collection_closed_at, NOW()) ELSE collection_closed_at END,
           settled_at = CASE WHEN p_new_status = 'settled' THEN NOW() ELSE settled_at END,
           updated_at = NOW()
     WHERE id = p_escrow_id;

    RETURN jsonb_build_object('success', true, 'new_status', p_new_status);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.transition_escrow_status(uuid, text, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.transition_escrow_status(uuid, text, uuid) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- Disputes — any entity (user/game/group/venue/escrow) can be disputed
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS commander_disputes (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    opener_user_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    subject_type      text NOT NULL CHECK (subject_type IN ('home_game','home_group','venue','player','escrow','contribution','settlement')),
    subject_id        text NOT NULL,  -- uuid or int cast to text
    category          text NOT NULL CHECK (category IN ('payment_missing','unfair_payout','player_conduct','host_conduct','safety','fraud','incorrect_info','other')),
    summary           text NOT NULL CHECK (length(summary) BETWEEN 10 AND 2000),
    evidence_urls     text[],
    amount_disputed   numeric(10,2),  -- for payment disputes
    respondent_user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,  -- who's being disputed
    status            text NOT NULL DEFAULT 'opened' 
                        CHECK (status IN ('opened','investigating','awaiting_response','resolved_favor_opener','resolved_favor_respondent','dismissed','escalated','withdrawn')),
    priority          text NOT NULL DEFAULT 'normal' 
                        CHECK (priority IN ('low','normal','high','urgent')),
    assigned_to       uuid REFERENCES profiles(id) ON DELETE SET NULL,
    resolution_note   text,
    opened_at         timestamptz NOT NULL DEFAULT NOW(),
    resolved_at       timestamptz,
    updated_at        timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_disputes_opener ON commander_disputes(opener_user_id, opened_at DESC);
CREATE INDEX idx_disputes_subject ON commander_disputes(subject_type, subject_id);
CREATE INDEX idx_disputes_status_priority 
    ON commander_disputes(status, priority, opened_at) 
    WHERE status IN ('opened','investigating','awaiting_response','escalated');
CREATE INDEX idx_disputes_respondent 
    ON commander_disputes(respondent_user_id, opened_at DESC) 
    WHERE respondent_user_id IS NOT NULL;

ALTER TABLE commander_disputes ENABLE ROW LEVEL SECURITY;

-- Opener sees own; respondent sees their side; otherwise hidden
CREATE POLICY disputes_parties_select ON commander_disputes
  FOR SELECT TO authenticated USING (
    opener_user_id = auth.uid() OR respondent_user_id = auth.uid()
  );
CREATE POLICY disputes_opener_insert ON commander_disputes
  FOR INSERT TO authenticated WITH CHECK (opener_user_id = auth.uid());
CREATE POLICY disputes_opener_withdraw ON commander_disputes
  FOR UPDATE TO authenticated 
    USING (opener_user_id = auth.uid() AND status IN ('opened','investigating','awaiting_response'))
    WITH CHECK (opener_user_id = auth.uid() AND status = 'withdrawn');

-- Dispute messages (threaded conversation)
CREATE TABLE IF NOT EXISTS commander_dispute_messages (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dispute_id   uuid NOT NULL REFERENCES commander_disputes(id) ON DELETE CASCADE,
    author_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    author_role  text NOT NULL CHECK (author_role IN ('opener','respondent','admin')),
    message      text NOT NULL CHECK (length(message) BETWEEN 1 AND 5000),
    attachments  text[],
    is_internal  boolean NOT NULL DEFAULT false,  -- admin-only notes
    created_at   timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dispute_messages_thread ON commander_dispute_messages(dispute_id, created_at);

ALTER TABLE commander_dispute_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY dispute_messages_parties_select ON commander_dispute_messages
  FOR SELECT TO authenticated USING (
    NOT is_internal 
    AND dispute_id IN (SELECT id FROM commander_disputes 
                        WHERE opener_user_id = auth.uid() OR respondent_user_id = auth.uid())
  );
CREATE POLICY dispute_messages_parties_insert ON commander_dispute_messages
  FOR INSERT TO authenticated WITH CHECK (
    author_id = auth.uid()
    AND is_internal = false
    AND dispute_id IN (SELECT id FROM commander_disputes 
                        WHERE opener_user_id = auth.uid() OR respondent_user_id = auth.uid())
  );

-- RPCs
CREATE OR REPLACE FUNCTION public.open_dispute(
    p_caller_user_id   uuid,
    p_subject_type     text,
    p_subject_id       text,
    p_category         text,
    p_summary          text,
    p_respondent_id    uuid DEFAULT NULL,
    p_amount_disputed  numeric DEFAULT NULL,
    p_evidence_urls    text[] DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_id uuid; v_recent_count int;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    
    -- Rate limit: max 10 disputes per 24h
    SELECT COUNT(*) INTO v_recent_count FROM commander_disputes 
     WHERE opener_user_id = p_caller_user_id AND opened_at > NOW() - INTERVAL '24 hours';
    IF v_recent_count >= 10 THEN RAISE EXCEPTION 'RATE_LIMITED' USING HINT='max 10 disputes per 24 hours'; END IF;

    INSERT INTO commander_disputes (
        opener_user_id, subject_type, subject_id, category, summary,
        respondent_user_id, amount_disputed, evidence_urls,
        priority
    ) VALUES (
        p_caller_user_id, p_subject_type, p_subject_id, p_category, p_summary,
        p_respondent_id, p_amount_disputed, p_evidence_urls,
        CASE 
            WHEN p_category IN ('fraud','safety') THEN 'urgent'
            WHEN p_category IN ('payment_missing','unfair_payout') THEN 'high'
            ELSE 'normal'
        END
    ) RETURNING id INTO v_id;

    RETURN jsonb_build_object('success', true, 'dispute_id', v_id);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.open_dispute(uuid, text, text, text, text, uuid, numeric, text[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.open_dispute(uuid, text, text, text, text, uuid, numeric, text[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.post_dispute_message(
    p_dispute_id      uuid,
    p_caller_user_id  uuid,
    p_message         text,
    p_attachments     text[] DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_dispute RECORD; v_role text; v_id uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF length(trim(p_message)) < 1 THEN RAISE EXCEPTION 'EMPTY_MESSAGE'; END IF;

    SELECT * INTO v_dispute FROM commander_disputes WHERE id = p_dispute_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'DISPUTE_NOT_FOUND'; END IF;

    v_role := CASE 
        WHEN p_caller_user_id = v_dispute.opener_user_id THEN 'opener'
        WHEN p_caller_user_id = v_dispute.respondent_user_id THEN 'respondent'
        ELSE NULL END;
    IF v_role IS NULL THEN RAISE EXCEPTION 'NOT_A_PARTY'; END IF;

    INSERT INTO commander_dispute_messages (dispute_id, author_id, author_role, message, attachments)
    VALUES (p_dispute_id, p_caller_user_id, v_role, p_message, p_attachments)
    RETURNING id INTO v_id;

    -- If opener posts, flip back to awaiting admin review; if respondent, flag for review
    UPDATE commander_disputes 
       SET status = CASE 
               WHEN v_role = 'opener' AND status = 'awaiting_response' THEN 'investigating'
               WHEN v_role = 'respondent' AND status IN ('opened','investigating') THEN 'investigating'
               ELSE status END,
           updated_at = NOW()
     WHERE id = p_dispute_id;

    RETURN jsonb_build_object('success', true, 'message_id', v_id);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.post_dispute_message(uuid, uuid, text, text[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.post_dispute_message(uuid, uuid, text, text[]) TO authenticated, service_role;
