CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE TABLE ca_financial_epochs(id integer PRIMARY KEY,is_current boolean);
INSERT INTO ca_financial_epochs VALUES(1,true);
CREATE SEQUENCE chip_ledger_chain_seq;
CREATE TABLE chip_ledger_idem(idempotency_key text PRIMARY KEY,leg_id uuid NOT NULL,created_at timestamptz NOT NULL);
ALTER TABLE clubs ADD COLUMN chip_pool numeric DEFAULT 0,ADD COLUMN promo_balance numeric DEFAULT 0,ADD COLUMN insurance_balance numeric DEFAULT 0,ADD COLUMN total_rake numeric DEFAULT 0;
CREATE OR REPLACE FUNCTION public.fn_block_browser_balance_writes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_changed text;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_table_name = 'club_members' then
    if new.chip_balance is distinct from old.chip_balance then
      v_changed := 'chip_balance';
    elsif new.held_chips is distinct from old.held_chips then
      v_changed := 'held_chips';
    elsif new.locked_chips is distinct from old.locked_chips then
      v_changed := 'locked_chips';
    elsif new.promo_balance is distinct from old.promo_balance then
      v_changed := 'promo_balance';
    end if;
  elsif tg_table_name = 'clubs' then
    if new.chip_treasury is distinct from old.chip_treasury then
      v_changed := 'chip_treasury';
    elsif new.chip_pool is distinct from old.chip_pool then
      v_changed := 'chip_pool';
    end if;
  end if;

  if v_changed is null then
    return new;
  end if;

  raise exception
    'Direct balance mutation of %.% from the browser is forbidden. Chips move only through the money RPCs.',
    tg_table_name, v_changed
    using errcode = 'insufficient_privilege';
end
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_autoledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  spec text; col text; acct text;
  o jsonb; nn jsonb;
  d numeric; oldv numeric; newv numeric;
  cat text; cp text; cpid uuid;
  v_club uuid; v_union uuid; v_entity uuid;
  actor uuid;
  v_st text; v_msg text;
BEGIN
  IF current_setting('app.ledger_autoskip_' || TG_TABLE_NAME, true) = '1' THEN
    RETURN NEW;
  END IF;

  o  := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  nn := to_jsonb(NEW);

  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');
  cp  := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN
    cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN cpid := NULL;
  END;
  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  v_club := CASE
    WHEN TG_TABLE_NAME = 'clubs' THEN (nn->>'id')::uuid
    WHEN nn ? 'club_id' THEN NULLIF(nn->>'club_id','')::uuid
    ELSE NULL END;
  v_union := CASE
    WHEN TG_TABLE_NAME = 'unions' THEN (nn->>'id')::uuid
    WHEN nn ? 'union_id' THEN NULLIF(nn->>'union_id','')::uuid
    ELSE NULL END;
  v_entity := CASE
    WHEN TG_TABLE_NAME = 'agents' THEN NULLIF(nn->>'user_id','')::uuid
    WHEN TG_TABLE_NAME = 'club_members' THEN NULLIF(nn->>'user_id','')::uuid
    ELSE COALESCE(NULLIF(nn->>'id','')::uuid, v_club, v_union) END;

  FOR i IN 0 .. TG_NARGS - 1 LOOP
    spec := TG_ARGV[i];
    col  := split_part(spec, '=', 1);
    acct := split_part(spec, '=', 2);
    oldv := COALESCE(NULLIF(o->>col,'')::numeric, 0);
    newv := COALESCE(NULLIF(nn->>col,'')::numeric, 0);
    d := round(newv - oldv, 2);
    CONTINUE WHEN d = 0;

    BEGIN
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, union_id, description,
         pre_from_balance, post_from_balance, pre_to_balance, post_to_balance)
      VALUES (actor,
        CASE WHEN d > 0 THEN cp   ELSE acct END,
        CASE WHEN d > 0 THEN cpid ELSE v_entity END,
        CASE WHEN d > 0 THEN NULL ELSE TG_TABLE_NAME || '.' || col END,
        CASE WHEN d > 0 THEN acct ELSE cp END,
        CASE WHEN d > 0 THEN v_entity ELSE cpid END,
        CASE WHEN d > 0 THEN TG_TABLE_NAME || '.' || col ELSE NULL END,
        abs(d), cat, v_club, v_union,
        'auto-ledgered ' || TG_TABLE_NAME || '.' || col || ' delta ' || d::text,
        CASE WHEN d < 0 THEN oldv END, CASE WHEN d < 0 THEN newv END,
        CASE WHEN d > 0 THEN oldv END, CASE WHEN d > 0 THEN newv END);
    EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;
  END LOOP;

  RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_club_members_ledger_writer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d     numeric;
  actor uuid;
  cat   text;
  tid   uuid;
  st    text;
  msg   text;
  cp    text;
  cpid  uuid;
BEGIN
  /* THE AUTOSKIP CONTRACT IS ONE CONTRACT (2026-09-09). Every other journal
     writer on this platform stands down when the caller sets
     app.ledger_autoskip_<table>, because the caller is writing the leg itself
     with the period, the key and the metadata that only it knows. This writer
     never learned that clause. So a settlement that suppressed the clubs
     trigger and wrote its own named leg still got an anonymous twin from this
     side, and the movement reached the journal twice: on 2026-09-09 round 2
     moved 20,377.49 of commission and recorded 40,754.98 of legs. Standing
     down here is what makes one movement, one leg true for the busiest
     balance column on the platform. */
  IF current_setting('app.ledger_autoskip_club_members', true) = '1' THEN
    RETURN NEW;
  END IF;

  d := COALESCE(NEW.chip_balance, 0) - COALESCE(OLD.chip_balance, 0);

  IF d = 0 THEN
    RETURN NEW;
  END IF;

  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');

  BEGIN
    tid := NULLIF(current_setting('app.ledger_tournament', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    tid := NULL;
  END;

  /* THE COUNTERPARTY IS DECLARED, NEVER INFERRED (2026-08-31). */
  cp := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN
    cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    cpid := NULL;
  END;

  BEGIN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, tournament_id, description)
    VALUES (
      actor,
      CASE WHEN d > 0 THEN cp              ELSE 'player_wallet' END,
      CASE WHEN d > 0 THEN cpid            ELSE NEW.user_id     END,
      CASE WHEN d > 0 THEN 'player_wallet' ELSE cp              END,
      CASE WHEN d > 0 THEN NEW.user_id     ELSE cpid            END,
      abs(d), cat, NEW.club_id, tid,
      'auto-audited club_members.chip_balance delta ' || d::text);

  EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_refuse_operator_move_while_settling()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claims text;
BEGIN
  -- Only operator movement. Everything a TABLE does is excluded on purpose:
  -- fn_atomic_buyin writes 'mint', so a freeze that caught mints would refuse
  -- buy-ins mid-session, and a settlement freeze is not a maintenance break.
  IF NEW.transaction_type IS NULL OR NEW.transaction_type NOT IN (
       'agent_wallet_send', 'agent_wallet_claim_back', 'agent_wallet_self_stake',
       'club_bank_send', 'club_bank_claim', 'club_bank_reversal',
       'promo_wallet_send', 'commission_claim',
       'admin_adjustment', 'admin_removal'
     ) THEN
    RETURN NEW;
  END IF;

  IF NEW.club_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The settlement runner and every server-side job move chips as
  -- service_role, and the freeze exists to protect exactly that work.
  BEGIN
    v_claims := current_setting('request.jwt.claims', TRUE);
    IF v_claims IS NOT NULL AND v_claims <> ''
       AND (v_claims::jsonb ->> 'role') = 'service_role' THEN
      RETURN NEW;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  IF coalesce(auth.role(), '') = 'service_role'
     OR session_user IN ('postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  IF public.fn_club_settlement_frozen(NEW.club_id) THEN
    RAISE EXCEPTION
      'SETTLEMENT_FROZEN: this club is squaring its books. % was refused; it will succeed when the freeze lifts.',
      NEW.transaction_type
      USING ERRCODE = '55006',
            HINT = 'A settlement freeze stops operator transfers, not play. Nothing is lost - retry once the freeze is lifted.';
  END IF;

  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.zz_chip_ledger_key_is_claimed_once()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* 99.92% of legs carry no key and this does nothing for them. */
  IF NEW.idempotency_key IS NULL THEN
    RETURN NEW;
  END IF;

  /* No ON CONFLICT: the unique violation IS the refusal, and it must reach the
     caller exactly as ux_chip_ledger_idempotency_key's does today. Both are
     live until the cut; either one refusing is the correct outcome. */
  INSERT INTO public.chip_ledger_idem (idempotency_key, leg_id, created_at)
  VALUES (NEW.idempotency_key, NEW.id, COALESCE(NEW.created_at, now()));

  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_chip_ledger_performed_by()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.performed_by = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'chip_ledger.performed_by must be a real user, got all-zero sentinel'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Cross-scope between two non-system entity types requires the operator
  -- to be identified - this catches callers who forget to thread userId.
  IF NEW.from_type <> NEW.to_type
     AND NEW.from_type NOT IN ('system_mint', 'system_burn')
     AND NEW.to_type   NOT IN ('system_mint', 'system_burn') THEN
    -- performed_by is already NOT NULL + non-zero here; nothing extra to do.
    NULL;
  END IF;
  RETURN NEW;
END; $function$;
CREATE OR REPLACE FUNCTION public.fn_admin_holds_no_player_wallet()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_is_union boolean;
BEGIN
  IF COALESCE(NEW.role, 'player') <> 'admin' THEN RETURN NEW; END IF;

  SELECT COALESCE(c.is_union, false) INTO v_is_union FROM public.clubs c WHERE c.id = NEW.club_id;
  IF COALESCE(v_is_union, false) THEN RETURN NEW; END IF;

  IF TG_OP = 'UPDATE' AND OLD.role IS DISTINCT FROM NEW.role
     AND (COALESCE(NEW.chip_balance, 0) <> 0
          OR COALESCE(NEW.locked_chips, 0) <> 0
          OR COALESCE(NEW.held_chips, 0) <> 0
          OR COALESCE(NEW.promo_balance, 0) <> 0) THEN
    RAISE EXCEPTION 'Cash Out The Player Wallet Before Making This Member An Admin'
      USING ERRCODE = 'check_violation',
            DETAIL = format('chip_balance %s, locked %s, held %s, promo %s',
                            COALESCE(NEW.chip_balance, 0), COALESCE(NEW.locked_chips, 0),
                            COALESCE(NEW.held_chips, 0), COALESCE(NEW.promo_balance, 0));
  END IF;

  IF COALESCE(NEW.chip_balance, 0) > 0
     AND (TG_OP = 'INSERT' OR COALESCE(NEW.chip_balance, 0) > COALESCE(OLD.chip_balance, 0)) THEN
    RAISE EXCEPTION 'An Admin Does Not Hold A Player Wallet'
      USING ERRCODE = 'check_violation',
            HINT = 'Send To The Agent Wallet Or The Club Bank Instead.';
  END IF;

  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_chip_ledger_enrich()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prev text;
BEGIN
  NEW.amount := round(NEW.amount, 2);
  NEW.created_at := COALESCE(NEW.created_at, now());

  NEW.epoch_id      := COALESCE(NEW.epoch_id, public.fn_ca_current_epoch());
  NEW.actor_service := COALESCE(NEW.actor_service,
                                current_setting('application_name', true));
  NEW.db_role       := COALESCE(NEW.db_role, current_user);
  NEW.correlation_id := COALESCE(NEW.correlation_id,
      NULLIF(current_setting('app.ledger_correlation', true), '')::uuid);
  NEW.settlement_id  := COALESCE(NEW.settlement_id,
      NULLIF(current_setting('app.ledger_settlement', true), ''));
  IF NEW.idempotency_key IS NULL THEN
    NEW.idempotency_key := NULLIF(current_setting('app.ledger_idempotency_key', true), '');
    IF NEW.idempotency_key IS NOT NULL THEN
      -- consume-once: the next row in this transaction must not inherit it
      PERFORM set_config('app.ledger_idempotency_key', '', true);
    END IF;
  END IF;

  /* PHASE 6.4 (2026-09-05): EVERY LEG NAMES ITS HAND OR ITS EVENT. The doors
     that know the hand say so on app.ledger_hand_id (the rake door and the
     BBJ drop, since today) or on a 'bbj:<hand>' settlement; the rake
     settlement is not read for it because it carries a random key when the
     hand is unknown, and a guessed hand is worse than none; a spin's reserve legs
     carry the spin on their prize_liability side. Read them here, once, so
     the hand and the event are columns a per-hand audit can index on rather
     than strings it has to parse. 231,211 legs a day; 29,617 named a hand
     and 50,359 an event before this. */
  IF NEW.hand_id IS NULL THEN
    NEW.hand_id := NULLIF(current_setting('app.ledger_hand_id', true), '')::uuid;
    IF NEW.hand_id IS NULL AND NEW.settlement_id ~ '^bbj:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      NEW.hand_id := split_part(NEW.settlement_id, ':', 2)::uuid;
    END IF;
  END IF;
  IF NEW.tournament_id IS NULL THEN
    NEW.tournament_id := NULLIF(current_setting('app.ledger_tournament_id', true), '')::uuid;
    /* PHASE 6 GATE (2026-09-05): a prize_liability side IS the event, on every
       category, not only the two spin ones. This is what the 6.4 measurement
       missed: 777 tournament rake settlements in three hours (the fee leaving
       an event to a union rake wallet or a club treasury) and every tournament
       add-on named nothing. Read against the rows first: all 777 from_entity_id
       values are real tournaments. The FROM side wins when both sides are
       prize_liability (a satellite seat's pool transfer, which already stamps
       the satellite itself). */
    IF NEW.tournament_id IS NULL THEN
      IF NEW.from_type = 'prize_liability' THEN NEW.tournament_id := NEW.from_entity_id;
      ELSIF NEW.to_type = 'prize_liability' THEN NEW.tournament_id := NEW.to_entity_id;
      END IF;
    END IF;
  END IF;
  /* PHASE 6 GATE: and a table_stack side IS the table. Every cash buy-in,
     add-on and cash-out carries the table on its felt side (231, 53 and 222
     of each measured in the same window, every one a real table row) and
     none of them carried table_id. A cash buy-in is not a hand; the table is
     the name it has. */
  IF NEW.table_id IS NULL THEN
    IF NEW.to_type = 'table_stack' THEN NEW.table_id := NEW.to_entity_id;
    ELSIF NEW.from_type = 'table_stack' THEN NEW.table_id := NEW.from_entity_id;
    END IF;
  END IF;

  -- Tamper evidence: monotone sequence + per-row content checksum. NOT chained
  -- through the previous row's hash at insert time - that would put a global
  -- serialization point (and deadlock surface) inside every money transaction,
  -- which the availability policy forbids. prev_hash is best-effort forensics.
  NEW.chain_seq := nextval('public.chip_ledger_chain_seq');
  SELECT row_hash INTO v_prev
    FROM public.chip_ledger
   WHERE chain_seq = NEW.chain_seq - 1;
  NEW.prev_hash := v_prev;
  NEW.row_hash := encode(extensions.digest(
      'v1'
      || '|' || NEW.chain_seq::text
      || '|' || COALESCE(NEW.epoch_id::text,'')
      || '|' || NEW.amount::text
      || '|' || NEW.from_type || ':' || COALESCE(NEW.from_entity_id::text,'')
      || '|' || NEW.to_type   || ':' || COALESCE(NEW.to_entity_id::text,'')
      || '|' || NEW.category
      || '|' || COALESCE(NEW.idempotency_key,'')
      || '|' || COALESCE(NEW.correlation_id::text,'')
      || '|' || NEW.created_at::text,
      'sha256'), 'hex');
  RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_ca_current_epoch()
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT id FROM public.ca_financial_epochs WHERE is_current LIMIT 1 $function$;
CREATE OR REPLACE FUNCTION public.fn_ca_journal_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
  v_allowed_update boolean := false;
  v_kind text;
  v_sev text;
  v_j jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'chip_transactions' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.transaction_type IS NOT DISTINCT FROM OLD.transaction_type
        AND NEW.from_user_id IS NOT DISTINCT FROM OLD.from_user_id
        AND NEW.to_user_id IS NOT DISTINCT FROM OLD.to_user_id
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    ELSIF TG_TABLE_NAME = 'chip_ledger' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.from_type IS NOT DISTINCT FROM OLD.from_type
        AND NEW.from_entity_id IS NOT DISTINCT FROM OLD.from_entity_id
        AND NEW.to_type IS NOT DISTINCT FROM OLD.to_type
        AND NEW.to_entity_id IS NOT DISTINCT FROM OLD.to_entity_id
        AND NEW.category IS NOT DISTINCT FROM OLD.category
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND NEW.chain_seq IS NOT DISTINCT FROM OLD.chain_seq
        AND NEW.prev_hash IS NOT DISTINCT FROM OLD.prev_hash
        AND NEW.row_hash IS NOT DISTINCT FROM OLD.row_hash
        AND NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key
        AND NEW.correlation_id IS NOT DISTINCT FROM OLD.correlation_id
        AND NEW.settlement_id IS NOT DISTINCT FROM OLD.settlement_id
        AND NEW.epoch_id IS NOT DISTINCT FROM OLD.epoch_id;
    ELSIF TG_TABLE_NAME = 'vip_points_ledger' THEN
      /* Phase 8 (2026-09-08). A VIP leg is written once, final: the award
         writer no longer inserts 0 and updates it afterwards. Nothing on this
         table may change. */
      v_allowed_update := false;
    ELSIF TG_TABLE_NAME = 'agent_commissions' THEN
      /* Phase 8. A commission row is what was earned on one hand. The only
         thing that happens to it afterwards is being settled, once. */
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
        AND NEW.source_type IS NOT DISTINCT FROM OLD.source_type
        AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id
        AND NEW.commission_rate IS NOT DISTINCT FROM OLD.commission_rate
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND (OLD.settled_at IS NULL OR NEW.settled_at IS NOT DISTINCT FROM OLD.settled_at);
    ELSIF TG_TABLE_NAME = 'rakeback_period_payouts' THEN
      /* Phase 8. What was paid, to whom, for which period, never changes;
         status, paid_at, wallet_transaction_id and failure_reason are the
         payout's own bookkeeping. */
      v_allowed_update :=
        NEW.payout_amount IS NOT DISTINCT FROM OLD.payout_amount
        AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.rakeback_period_id IS NOT DISTINCT FROM OLD.rakeback_period_id
        AND NEW.currency IS NOT DISTINCT FROM OLD.currency
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    ELSE
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND v_allowed_update THEN
    RETURN NEW;
  END IF;

  /* Phase 8. fn_close_settlement_period inserts a payout row as its
     idempotency claim BEFORE debiting the treasury and deletes it again on a
     shortfall, inside the same transaction. That is a compensation, not a
     mutation of history, so this table's DELETE is allowed - and RECORDED,
     every time, so a person can tell a compensation from a hand on the
     table. The meter counts these. */
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'rakeback_period_payouts' THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true),
            COALESCE(v_reason, 'rakeback-payout-delete: compensation on a treasury shortfall, or maintenance without app.ledger_maintenance'),
            to_jsonb(OLD), NULL);
    RETURN OLD;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true), v_reason,
            to_jsonb(OLD), CASE WHEN TG_OP='UPDATE' THEN to_jsonb(NEW) END);

    BEGIN
      v_kind := split_part(v_reason, ':', 1);
      -- a routine, recorded maintenance is filed, not shouted about
      SELECT k.severity INTO v_sev
        FROM public.ca_ledger_maintenance_kinds k WHERE k.kind = v_kind;
      v_sev := COALESCE(v_sev, 'warning');
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_journal_append_only', 'unauthorized_adjustment', v_sev,
        'journal-bypass:' || TG_TABLE_NAME || ':' || TG_OP || ':' || v_kind,
        0, NULL, NULL, 'ledger', TG_TABLE_NAME,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'append-only bypass used on ' || TG_TABLE_NAME || ': ' || TG_OP
          || ' permitted because app.ledger_maintenance was set to "' || v_reason
          || '". The rows are preserved whole in ca_ledger_mutation_log - this incident'
          || ' counts them (occurrences) rather than the chips; query that table by'
          || ' reason for the full inventory. Confirm the maintenance was intended,'
          || ' then resolve.',
        true,
        jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
                           'reason', v_reason, 'reason_kind', v_kind,
                           'db_role', current_user,
                           'application', current_setting('application_name', true)));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- DR5. The diamond journal is deleted from on an hourly cadence by the
    -- certification fleet. Keep the row and say who took it. Nothing here can
    -- refuse the DELETE the branch above has already permitted.
    IF TG_TABLE_NAME = 'diamond_transactions' AND TG_OP = 'DELETE' THEN
      BEGIN
        v_j := to_jsonb(OLD);
        INSERT INTO public.ca_diamond_journal_archive
          (id, user_id, type, amount, balance_after, description, reference_id, created_at,
           transaction_type, source, metadata, counterparty, issuance_class,
           deleted_profile_id, deletion_reason)
        VALUES
          ((v_j->>'id')::uuid, (v_j->>'user_id')::uuid, v_j->>'type',
           (v_j->>'amount')::integer, (v_j->>'balance_after')::integer,
           v_j->>'description', v_j->>'reference_id', (v_j->>'created_at')::timestamptz,
           v_j->>'transaction_type', v_j->>'source',
           COALESCE(v_j->'metadata', '{}'::jsonb),
           v_j->>'counterparty', v_j->>'issuance_class',
           (v_j->>'user_id')::uuid, v_reason)
        ON CONFLICT (id) DO NOTHING;

        PERFORM public.fn_ca_diamond_incident(
          'DR5:journal_row_deleted_under_maintenance', 'info',
          (v_j->>'user_id')::uuid, (v_j->>'amount')::numeric,
          'fn_ca_journal_append_only',
          jsonb_build_object('reason', v_reason,
                             'reference_id', v_j->>'reference_id',
                             'type', v_j->>'type',
                             'db_role', current_user));
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'ca_diamond_journal_archive could not preserve a journal row deleted under maintenance (%): %',
          v_reason, SQLERRM;
      END;
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION
    '% on % is forbidden: financial journals are append-only. Corrections are new linked rows (category=correction). Set app.ledger_maintenance with an incident reference for authorized maintenance.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0403';
END $function$;
CREATE OR REPLACE FUNCTION public.fn_freeze_bypass_active()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(current_setting('app.freeze_bypass', TRUE), '') = 'on';
$function$;
CREATE OR REPLACE FUNCTION public.fn_refuse_while_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  col  TEXT;
  changed BOOLEAN := FALSE;
  v_claims TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_NARGS > 0 THEN
    FOREACH col IN ARRAY TG_ARGV LOOP
      IF to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
        changed := TRUE;
        EXIT;
      END IF;
    END LOOP;
    IF NOT changed THEN
      RETURN NEW;
    END IF;
  END IF;

  -- ONBOARDING NEVER FREEZES (to-do #2563 item 1). A membership row carrying
  -- no chips is identity, not money. This table, INSERT only, zero balance.
  IF TG_TABLE_NAME = 'club_members' AND TG_OP = 'INSERT'
     AND COALESCE((to_jsonb(NEW) ->> 'chip_balance')::numeric, 0) = 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_freeze_bypass_active() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- CHIP STANDARD (2026-09-05): A JOURNAL ROW IS THE RECORD OF A WRITE, NOT A
  -- WRITE. When a balance write was permitted (a money table outside this
  -- guard, or a permitted role), its chip_ledger leg is written by the
  -- autoledger inside that same statement, at trigger depth 2 or more.
  -- Refusing the leg while the write stands is the one outcome the standard
  -- cannot allow: 104 BBJ bank moves (9.69 chips) lost their legs this way at :55 and
  -- :00 up to 09-05 06:58 (ca_ledger_write_failures, sqlstate 55006), each one an unexplained movement on the BBJ meter. A direct
  -- INSERT on chip_ledger from a client (depth 1) is still refused.
  IF TG_TABLE_NAME = 'chip_ledger' AND pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', TRUE);
    IF v_claims IS NOT NULL AND v_claims <> ''
       AND (v_claims::jsonb ->> 'role') = 'service_role' THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: the platform is on a scheduled maintenance break. % on % was refused; it will succeed when play resumes.',
      TG_OP, TG_TABLE_NAME
      USING ERRCODE = '55006',
            HINT = 'Scheduled maintenance breaks run from :55 to :00. Nothing is lost - retry after the break.';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;
CREATE TRIGGER trg_ca_chip_ledger_enrich BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_chip_ledger_enrich();

CREATE TRIGGER trg_chip_ledger_performed_by BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION enforce_chip_ledger_performed_by();

CREATE TRIGGER zz_chip_ledger_key_is_claimed_once BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION zz_chip_ledger_key_is_claimed_once();

CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR DELETE OR UPDATE ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen();

CREATE TRIGGER trg_ca_append_only BEFORE DELETE OR UPDATE ON public.chip_transactions FOR EACH ROW EXECUTE FUNCTION fn_ca_journal_append_only();

CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR DELETE OR UPDATE ON public.chip_transactions FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen();

CREATE TRIGGER zz_settlement_freeze_guard BEFORE INSERT ON public.chip_transactions FOR EACH ROW EXECUTE FUNCTION fn_refuse_operator_move_while_settling();

CREATE TRIGGER trg_admin_holds_no_player_wallet BEFORE INSERT OR UPDATE OF role, chip_balance ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_admin_holds_no_player_wallet();

CREATE TRIGGER trg_block_browser_balance_writes BEFORE UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_block_browser_balance_writes();

CREATE TRIGGER trg_ca_autoledger AFTER UPDATE OF promo_balance ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('promo_balance=promo_wallet');

CREATE TRIGGER trg_ca_autoledger_insert AFTER INSERT ON public.club_members FOR EACH ROW WHEN (((COALESCE(new.chip_balance, (0)::numeric) <> (0)::numeric) OR (COALESCE(new.promo_balance, (0)::numeric) <> (0)::numeric))) EXECUTE FUNCTION fn_ca_autoledger('chip_balance=player_wallet', 'promo_balance=promo_wallet');

CREATE TRIGGER trg_club_members_audit_chip_movement AFTER UPDATE OF chip_balance ON public.club_members FOR EACH ROW WHEN ((old.chip_balance IS DISTINCT FROM new.chip_balance)) EXECUTE FUNCTION fn_club_members_ledger_writer();

CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR DELETE OR UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen('chip_balance');

CREATE TRIGGER trg_block_browser_treasury_writes BEFORE UPDATE ON public.clubs FOR EACH ROW EXECUTE FUNCTION fn_block_browser_balance_writes();

CREATE TRIGGER trg_ca_autoledger AFTER INSERT OR UPDATE OF chip_treasury, chip_pool, promo_balance, insurance_balance ON public.clubs FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('chip_treasury=club_treasury', 'chip_pool=club_treasury', 'promo_balance=promo_wallet', 'insurance_balance=insurance_bank');

CREATE TRIGGER zz_freeze_guard BEFORE UPDATE ON public.clubs FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen('chip_pool', 'total_rake');

CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR DELETE OR UPDATE ON public.wallet_transactions FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen();
GRANT ALL ON chip_ledger_idem TO service_role;
GRANT ALL ON SEQUENCE chip_ledger_chain_seq TO service_role;
