-- Exact production money-trigger definitions captured read-only on 2026-09-09.
-- Loaded only after the guarded isolated fixture has created its synthetic wallet.
ALTER TABLE user_diamonds ADD UNIQUE(user_id), ADD COLUMN lifetime_earned bigint DEFAULT 0,
 ADD COLUMN lifetime_spent bigint DEFAULT 0, ADD COLUMN created_at timestamptz, ADD COLUMN updated_at timestamptz;
ALTER TABLE user_diamond_balance ADD UNIQUE(user_id), ADD COLUMN lifetime_earned bigint DEFAULT 0,
 ADD COLUMN lifetime_spent bigint DEFAULT 0, ADD COLUMN created_at timestamptz, ADD COLUMN updated_at timestamptz;
ALTER TABLE diamond_wallets ADD UNIQUE(user_id), ADD COLUMN lifetime_earned bigint DEFAULT 0,
 ADD COLUMN lifetime_spent bigint DEFAULT 0, ADD COLUMN updated_at timestamptz;
CREATE TABLE ca_diamond_balance_audit(user_id uuid,old_diamonds integer,new_diamonds integer,delta integer,
 is_cert boolean,db_role text,app_name text,journaled boolean,writer text,money_path text);
CREATE TABLE ca_ledger_write_failures(user_id uuid,delta numeric,sqlstate text,message text);
CREATE OR REPLACE FUNCTION public.fn_ca_audit_diamond_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old integer; v_new integer := COALESCE(NEW.diamonds, 0); v_delta integer;
  v_stack text; v_writer text; v_path text; v_journaled boolean := false;
  v_cert boolean; v_fixture boolean; v_sanctioned boolean; v_refuse boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.diamonds IS NOT DISTINCT FROM OLD.diamonds THEN RETURN NEW; END IF;
    v_old := COALESCE(OLD.diamonds, 0);
  ELSE
    IF v_new = 0 THEN RETURN NEW; END IF;
    v_old := 0;
  END IF;
  v_delta := v_new - v_old;

  BEGIN
    GET DIAGNOSTICS v_stack = PG_CONTEXT;
    SELECT (regexp_match(t.ln, 'function (?:public\.)?([A-Za-z0-9_]+)\('))[1] INTO v_writer
      FROM regexp_split_to_table(COALESCE(v_stack, ''), E'\n') WITH ORDINALITY AS t(ln, ord)
     WHERE t.ln ~ 'function (?:public\.)?[A-Za-z0-9_]+\('
       AND (regexp_match(t.ln, 'function (?:public\.)?([A-Za-z0-9_]+)\('))[1] <> 'fn_ca_audit_diamond_change'
     ORDER BY t.ord LIMIT 1;

    v_path := NULLIF(btrim(COALESCE(current_setting('app.money_path', true), '')), '');
    v_journaled := EXISTS (SELECT 1 FROM public.diamond_transactions dt
                            WHERE dt.user_id = NEW.id AND dt.created_at >= now() - interval '2 seconds');
    v_cert    := public.fn_ca_is_cert_account(NEW.id);
    v_fixture := public.fn_ca_is_fixture_account(NEW.id);

    -- DR6. Every writer here journals in the same transaction; most of them AFTER the balance
    -- write, which is why v_journaled is false at trigger time for a correct credit (2026-09-07
    -- review D4-D6). Gate by name, and by prefix for the daily-challenge family whose body name
    -- has drifted twice.
    v_sanctioned :=
         COALESCE(v_writer, '') IN ('add_diamonds_to_balance', 'deduct_diamonds', 'fn_ca_mint', 'fn_ca_burn',
                                    'send_wallet_diamond_transfer', 'send_stream_gift', 'handle_new_user',
                                    'fn_ca_diamond_born_with_balance', 'award_diamonds_v2',
                                    'fn_purchase_time_banks_v2', 'reconcile_diamond_purchase_refund',
                                    'fn_diamond_purchase_refund', 'fn_ca_journal_profile_deletion')
      OR COALESCE(v_writer, '') LIKE 'claim_daily_challenge%'
      OR COALESCE(v_path, '') IN ('add_diamonds_to_balance', 'deduct_diamonds', 'fn_ca_mint', 'fn_ca_burn',
                                  'send_wallet_diamond_transfer', 'send_stream_gift',
                                  'claim_daily_challenge', 'claim_daily_challenges');

    INSERT INTO public.ca_diamond_balance_audit
      (user_id, old_diamonds, new_diamonds, delta, is_cert, db_role, app_name, journaled, writer, money_path)
    VALUES (NEW.id, v_old, v_new, v_delta, v_cert, current_user,
            COALESCE(current_setting('application_name', true), ''), v_journaled, v_writer, v_path);

    IF v_delta <> 0 AND NOT v_journaled AND NOT v_sanctioned THEN
      -- DR6 (DIAMOND-RULINGS 17): once flipped, an unsanctioned balance write on a player
      -- account is refused; fixtures are never refused, only filed at info.
      v_refuse := NOT v_fixture
                  AND public.fn_ca_diamond_rule_mode('DR6:balance_changed_without_journal') = 'refuse';
      PERFORM public.fn_ca_diamond_incident(
        CASE WHEN v_fixture THEN 'DR6:fixture_harness_unjournaled' ELSE 'DR6:balance_changed_without_journal' END,
        CASE WHEN v_fixture THEN 'info' ELSE 'warning' END,
        NEW.id, v_delta, COALESCE(v_writer, v_path, '(no function frame)'),
        jsonb_build_object('money_path', v_path, 'is_cert', v_cert, 'is_fixture', v_fixture, 'tg_op', TG_OP,
                           'writer', v_writer, 'old_diamonds', v_old, 'new_diamonds', v_new,
                           'db_role', current_user,
                           'app_name', COALESCE(current_setting('application_name', true), ''),
                           'journaled_at_trigger_time', v_journaled, 'sanctioned_money_path', v_sanctioned));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.ca_ledger_write_failures (user_id, delta, sqlstate, message)
      VALUES (NEW.id, v_delta, SQLSTATE, 'diamond audit insert failed: ' || SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  IF v_refuse THEN
    RAISE EXCEPTION 'DR6: profiles.diamonds may only change through a sanctioned money path (writer %, delta %)',
      COALESCE(v_writer, v_path, '(no function frame)'), v_delta
      USING ERRCODE = 'P0406', HINT = 'Use add_diamonds_to_balance, deduct_diamonds, fn_ca_mint or fn_ca_burn.';
  END IF;
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_earn_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_engine text; v_period text; v_day date; v_budget bigint; v_spent bigint; v_awarded bigint;
    v_cap integer; v_cap_vip integer; v_is_vip boolean := false; v_at timestamptz;
    v_refuse text; v_refuse_detail text; v_armed boolean;
BEGIN
    BEGIN
        IF COALESCE(NEW.issuance_class, '') IN ('purchased', 'transferred', 'refund', 'admin', 'arena', 'spend', 'deletion', 'bridge') THEN
            RETURN NULL;
        END IF;
        IF COALESCE(NEW.type, '') = 'purchase' OR COALESCE(NEW.transaction_type, '') = 'purchase' THEN
            RETURN NULL;
        END IF;
        -- Fixture accounts are not players (2026-09-07 review DEF-03): their issuance is not
        -- promotional spend. Horses ARE players and are counted.
        IF public.fn_ca_is_fixture_account(NEW.user_id) THEN
            RETURN NULL;
        END IF;

        v_at     := COALESCE(NEW.created_at, now());
        v_engine := CASE WHEN NEW.issuance_class IS NULL THEN 'unclassified'
                         ELSE public.fn_ca_diamond_engine_of(NEW.type, NEW.transaction_type, NEW.source,
                                                             NEW.description, NEW.reference_id) END;
        v_period := to_char((v_at AT TIME ZONE 'America/Chicago'), 'YYYY-MM');
        v_day    := (v_at AT TIME ZONE 'America/Chicago')::date;

        -- THE PER-USER ROW FIRST. It is keyed (user_id, engine, day), so it contends only with the
        -- same player's own concurrent awards - which is to say, essentially never. It used to sit
        -- after the budget write and was therefore lost every time the budget write timed out,
        -- taking the per-user cap figure down with it.
        INSERT INTO public.diamond_user_daily_awards (user_id, engine, day, awarded, updated_at)
        VALUES (NEW.user_id, v_engine, v_day, NEW.amount, now())
        ON CONFLICT (user_id, engine, day) DO UPDATE
           SET awarded = diamond_user_daily_awards.awarded + EXCLUDED.awarded, updated_at = now()
        RETURNING awarded INTO v_awarded;

        -- THE BUDGET LINE EXISTS, BUT ITS TOTAL IS NO LONGER MAINTAINED HERE. This upsert touches
        -- the row only when the line is missing for a new period, so it is a once-a-month write,
        -- not a once-an-award one.
        INSERT INTO public.diamond_reward_budgets (period, engine, budget_diamonds, spent_diamonds, updated_at)
        VALUES (v_period, v_engine,
                COALESCE((SELECT b.budget_diamonds FROM public.diamond_reward_budgets b
                           WHERE b.engine = v_engine AND b.period < v_period
                           ORDER BY b.period DESC LIMIT 1), 2500000),
                0, now())
        ON CONFLICT (period, engine) DO NOTHING;

        -- ONE INSERT, NO CONTENTION. Two awards never touch the same row, so there is nothing to
        -- wait behind. This is the whole fix.
        INSERT INTO public.ca_diamond_engine_spend (period, engine, user_id, amount, journal_id, at)
        VALUES (v_period, v_engine, NEW.user_id, NEW.amount, NEW.id, v_at)
        ON CONFLICT (journal_id) DO NOTHING;

        -- RULING 21: THE ENGINE'S MONTHLY TOTAL IS A FORECAST, NOT A GATE. It is a pot shared
        -- between players, so refusing on it punishes whoever arrives last for what everybody
        -- else earned. The spend row appended above is the measurement, and the economy report
        -- reads it; nothing here refuses, and no incident is filed per award - daily_missions is
        -- 4.2x its line today, so one would fire on every single award and be muted inside a day
        -- (10.84). The only cap that refuses is the per-user one below.

        SELECT c.max_per_user_per_day, c.max_per_user_per_day_vip INTO v_cap, v_cap_vip
          FROM public.diamond_engine_daily_caps c WHERE c.engine = v_engine;
        IF v_cap_vip IS NOT NULL THEN
            SELECT COALESCE(p.is_vip, false) AND (COALESCE(p.vip_tier, '') = 'lifetime'
                     OR (p.vip_expires_at IS NOT NULL AND p.vip_expires_at > now()))
              INTO v_is_vip FROM public.profiles p WHERE p.id = NEW.user_id;
            IF COALESCE(v_is_vip, false) THEN v_cap := v_cap_vip; END IF;
        END IF;

        IF v_cap IS NOT NULL AND v_awarded > v_cap THEN
            IF public.fn_ca_diamond_rule_mode('DR7:user_over_daily_cap') = 'refuse' THEN
                v_refuse := COALESCE(v_refuse, 'DR7:user_over_daily_cap');
                v_refuse_detail := COALESCE(v_refuse_detail, format('engine %s day %s cap %s awarded %s', v_engine, v_day, v_cap, v_awarded));
            END IF;
            PERFORM public.fn_ca_diamond_incident('DR7:user_over_daily_cap', 'warning', NEW.user_id, NEW.amount,
                'fn_ca_diamond_earn_ledger',
                jsonb_build_object('engine', v_engine, 'day', v_day, 'is_vip', v_is_vip,
                                   'max_per_user_per_day', v_cap, 'awarded_today', v_awarded,
                                   'journal_id', NEW.id, 'reference_id', NEW.reference_id));
        END IF;
    EXCEPTION WHEN OTHERS THEN
        -- A FAILURE HERE MEANS A GUARD DID NOT RUN, and that is a different thing from a counter
        -- being late. While both rules are in `log` it is a warning; the moment either is armed to
        -- refuse, a write that could not complete is the guard failing OPEN, so it is CRITICAL and
        -- says so. The award is still paid: a player never loses an earned reward because our
        -- bookkeeping stumbled (10.9 rule 3), and "I could not tell" gets its own severity rather
        -- than being folded into silence (10.86).
        -- Only the per-user cap can refuse now (ruling 21), so it alone decides whether a
        -- write that could not complete means a guard failed open. The engine pot is a forecast
        -- and its rule row is deleted below; consulting a rule that no longer exists would read
        -- as armed while being nothing at all.
        v_armed := public.fn_ca_diamond_rule_mode('DR7:user_over_daily_cap') = 'refuse';
        PERFORM public.fn_ca_diamond_incident('DR7:ledger_write_failed',
            CASE WHEN v_armed THEN 'critical' ELSE 'warning' END, NEW.user_id, NEW.amount,
            'fn_ca_diamond_earn_ledger',
            jsonb_build_object('sqlstate', SQLSTATE, 'sqlerrm', SQLERRM, 'journal_id', NEW.id,
                               'reference_id', NEW.reference_id, 'rules_armed', v_armed,
                               'note', CASE WHEN v_armed
                                            THEN 'A rule is armed to refuse and this write did not complete, so neither cap was evaluated for this award. The guard failed OPEN.'
                                            ELSE 'Both rules are in log mode; nothing was refused either way.' END));
    END;
    -- DIAMOND-RULINGS 17/18: a flipped DR7 refuses the credit. Raising here aborts the writer's
    -- whole transaction (balance, journal, ledger rows), so nothing is issued and nothing is
    -- half-written. The incident above rolls back with it; the writer's error carries the reason.
    IF v_refuse IS NOT NULL THEN
        RAISE EXCEPTION '%: promotional issuance refused (%)', v_refuse, v_refuse_detail
            USING ERRCODE = 'P0407';
    END IF;
    RETURN NULL;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_journal_classifier()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_type text := COALESCE(NEW.transaction_type, NEW.type, 'unknown');
  v_stack text; v_writer text; v_filled boolean := false;
BEGIN
  IF NEW.issuance_class IS NULL THEN
    v_filled := true;
    NEW.issuance_class := CASE
      WHEN v_type = 'purchase' THEN 'purchased'
      WHEN v_type = 'refund' OR right(v_type, 7) = '_refund' THEN 'refund'
      WHEN v_type IN ('transfer', 'diamond_gift_received', 'live_gift_received', 'diamond_received',
                      'diamond_gift_sent', 'live_gift_sent', 'spend_transfer') THEN 'transferred'
      WHEN v_type = 'adjustment' THEN 'admin'
      WHEN v_type = 'mint' THEN 'admin'
      WHEN v_type = 'burn' THEN 'deletion'
      WHEN v_type IN ('union_grant', 'signup_bonus') THEN 'promotional'
      WHEN COALESCE(NEW.amount, 0) < 0 THEN 'spend'
      WHEN EXISTS (SELECT 1 FROM public.diamond_reward_catalog c WHERE c.action_key = v_type)
           OR COALESCE(NEW.description, '') LIKE 'Diamond Rewards v2:%' THEN 'promotional'
      ELSE 'earned'
    END;
  END IF;
  IF NEW.counterparty IS NULL THEN
    v_filled := true;
    NEW.counterparty := CASE NEW.issuance_class
      WHEN 'purchased' THEN 'purchase_clearing'
      WHEN 'refund' THEN CASE WHEN v_type IN ('refund', 'stripe') THEN 'purchase_clearing' ELSE 'revenue:' || v_type END
      WHEN 'transferred' THEN 'player:' || COALESCE(NEW.metadata->>'recipient_id', NEW.metadata->>'sender_id', 'unknown')
      WHEN 'admin' THEN 'adjustment'
      WHEN 'deletion' THEN 'retired'
      WHEN 'spend' THEN 'revenue:' || v_type
      ELSE 'promo_budget:' || public.fn_ca_diamond_engine_of(NEW.type, NEW.transaction_type, NEW.source, NEW.description, NEW.reference_id)
    END;
  END IF;
  IF v_filled THEN
    BEGIN
      GET DIAGNOSTICS v_stack = PG_CONTEXT;
      SELECT (regexp_match(t.ln, 'function (?:public\.)?([A-Za-z0-9_]+)\('))[1] INTO v_writer
        FROM regexp_split_to_table(COALESCE(v_stack, ''), E'\n') WITH ORDINALITY AS t(ln, ord)
       WHERE t.ln ~ 'function (?:public\.)?[A-Za-z0-9_]+\('
         AND (regexp_match(t.ln, 'function (?:public\.)?([A-Za-z0-9_]+)\('))[1] <> 'fn_ca_diamond_journal_classifier'
       ORDER BY t.ord LIMIT 1;
      PERFORM public.fn_ca_diamond_incident(
        'DR12:journal_row_unclassified_by_writer', 'info', NEW.user_id, NEW.amount,
        COALESCE(v_writer, '(no function frame)'),
        jsonb_build_object('type', NEW.type, 'transaction_type', NEW.transaction_type,
                           'description', left(NEW.description, 120), 'reference_id', NEW.reference_id,
                           'classified_as', NEW.issuance_class, 'counterparty', NEW.counterparty,
                           'note', 'the writer left issuance_class or counterparty NULL; the classifier filled them. Fix the writer.'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_diamond_balance_mirrors_canonical()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.diamond_balance := NEW.diamonds;
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_diamond_side_tables_follow_profiles()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_delta bigint := CASE WHEN TG_OP = 'INSERT'
                         THEN COALESCE(NEW.diamonds, 0)
                         ELSE COALESCE(NEW.diamonds, 0) - COALESCE(OLD.diamonds, 0) END;
BEGIN
  IF TG_OP <> 'INSERT' AND v_delta = 0 THEN RETURN NEW; END IF;
  BEGIN
    INSERT INTO public.user_diamonds (user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at)
    VALUES (NEW.id, GREATEST(COALESCE(NEW.diamonds, 0), 0), GREATEST(v_delta, 0), GREATEST(-v_delta, 0), now(), now())
    ON CONFLICT (user_id) DO UPDATE
      SET balance = GREATEST(COALESCE(NEW.diamonds, 0), 0),
          lifetime_earned = public.user_diamonds.lifetime_earned + GREATEST(v_delta, 0),
          lifetime_spent  = public.user_diamonds.lifetime_spent  + GREATEST(-v_delta, 0),
          updated_at = now();
    INSERT INTO public.user_diamond_balance (user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at)
    VALUES (NEW.id, GREATEST(COALESCE(NEW.diamonds, 0), 0)::int, GREATEST(v_delta, 0)::int, GREATEST(-v_delta, 0)::int, now(), now())
    ON CONFLICT (user_id) DO UPDATE
      SET balance = GREATEST(COALESCE(NEW.diamonds, 0), 0)::int,
          lifetime_earned = public.user_diamond_balance.lifetime_earned + GREATEST(v_delta, 0)::int,
          lifetime_spent  = public.user_diamond_balance.lifetime_spent  + GREATEST(-v_delta, 0)::int,
          updated_at = now();
    INSERT INTO public.diamond_wallets (user_id, balance, lifetime_earned, lifetime_spent, updated_at)
    VALUES (NEW.id, GREATEST(COALESCE(NEW.diamonds, 0), 0)::int, GREATEST(v_delta, 0)::int, GREATEST(-v_delta, 0)::int, now())
    ON CONFLICT (user_id) DO UPDATE
      SET balance = GREATEST(COALESCE(NEW.diamonds, 0), 0)::int,
          lifetime_earned = COALESCE(public.diamond_wallets.lifetime_earned, 0) + GREATEST(v_delta, 0)::int,
          lifetime_spent  = COALESCE(public.diamond_wallets.lifetime_spent, 0)  + GREATEST(-v_delta, 0)::int,
          updated_at = now();
  EXCEPTION WHEN OTHERS THEN
    -- A mirror is a mirror: it must never be able to refuse the thing it mirrors (2026-09-07 review
    -- D10: the two side tables carry FKs to auth.users and the seeder inserts the profile first).
    PERFORM public.fn_ca_diamond_incident('DR10:mirror_write_failed', 'warning', NEW.id, NEW.diamonds,
      'fn_diamond_side_tables_follow_profiles',
      jsonb_build_object('sqlstate', SQLSTATE, 'sqlerrm', SQLERRM, 'tg_op', TG_OP));
  END;
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_enforce_anti_farming_caps()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
 DECLARE
   v_recipient uuid;
   v_check     jsonb;
   v_kingfish  uuid := '47965354-0e56-43ef-931c-ddaab82af765';
 BEGIN
   -- Only enforce on outbound (debit) rows
   IF NEW.amount IS NULL OR NEW.amount >= 0 THEN
     RETURN NEW;
   END IF;

   -- Only on user→user diamond movement channels.
   -- COALESCE coerces NULL to '' so NULL columns evaluate to FALSE (not NULL)
   -- in the IN check. Critical because deduct_diamonds writes source=NULL on
   -- every non-gift call (game_cost, course_purchase, etc.) and we need those
   -- to fall through to the early RETURN NEW.
   IF NOT (
        COALESCE(NEW.transaction_type, '') IN ('live_gift_sent','diamond_gift_sent')
     OR COALESCE(NEW.source, '') IN ('stream_gift','wallet_transfer','wallet_diamond_transfer')
   ) THEN
     RETURN NEW;
   END IF;

   -- KINGFISH sender bypass
   IF NEW.user_id = v_kingfish THEN
     RETURN NEW;
   END IF;

   -- Recipient_id required in metadata for enforced channels
   v_recipient := NULLIF(NEW.metadata->>'recipient_id', '')::uuid;
   IF v_recipient IS NULL THEN
     RAISE EXCEPTION 'Anti-farming: recipient_id missing from metadata for % transaction',
       COALESCE(NEW.transaction_type, NEW.source)
       USING ERRCODE = 'check_violation';
   END IF;

   -- Delegate to shared cap function
   v_check := public.fn_check_anti_farming_gift_cap(NEW.user_id, v_recipient, ABS(NEW.amount));

   IF NOT (v_check->>'allowed')::boolean THEN
     RAISE EXCEPTION 'Anti-farming: %', v_check->>'reason'
       USING ERRCODE = 'check_violation', DETAIL = v_check::text;
   END IF;

   RETURN NEW;
 END;
 $function$
;
CREATE TRIGGER aa_ca_diamond_journal_classifier BEFORE INSERT ON diamond_transactions FOR EACH ROW EXECUTE FUNCTION fn_ca_diamond_journal_classifier();
CREATE TRIGGER trg_ca_diamond_earn_ledger AFTER INSERT ON diamond_transactions FOR EACH ROW WHEN (NEW.amount>0) EXECUTE FUNCTION fn_ca_diamond_earn_ledger();
CREATE TRIGGER trg_enforce_anti_farming_caps BEFORE INSERT ON diamond_transactions FOR EACH ROW EXECUTE FUNCTION fn_enforce_anti_farming_caps();
CREATE TRIGGER trg_aa_diamond_balance_mirrors_canonical BEFORE INSERT OR UPDATE OF diamonds,diamond_balance ON profiles FOR EACH ROW EXECUTE FUNCTION fn_diamond_balance_mirrors_canonical();
CREATE TRIGGER trg_diamond_side_tables_follow_profiles AFTER INSERT OR UPDATE OF diamonds ON profiles FOR EACH ROW EXECUTE FUNCTION fn_diamond_side_tables_follow_profiles();
CREATE TRIGGER zz_ca_audit_diamond_change AFTER INSERT OR UPDATE OF diamonds ON profiles FOR EACH ROW EXECUTE FUNCTION fn_ca_audit_diamond_change();
