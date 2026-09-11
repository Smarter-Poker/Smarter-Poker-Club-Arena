-- Reserved by scripts/new-migration.mjs. D8, operative Revision 6 (2026-09-11).
-- Permanent one-item authority; no cohort rows, repair loop, schedule, balance
-- creation, or report-name authorization. All imported figures are assertions
-- against server-derived source facts. Unprovable historical shapes refuse.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- The shared qualifier is installed before this reserved migration version.
-- Failed attempts never become stack evidence; successful records must pass
-- its exact independent conservation and one-to-one identity proof.
DO $accepted_receipt_dependency$
DECLARE p pg_proc%ROWTYPE;
BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_accepted_tournament_settlement_fact(jsonb)');
 IF NOT FOUND OR md5(p.prosrc)<>'0be7ce46c91572336ee97c80e827428d'
    OR p.proowner<>'postgres'::regrole OR NOT p.prosecdef
    OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp','TimeZone=UTC']::text[]
    OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
    OR p.provolatile<>'i' OR p.prorettype<>'jsonb'::regtype
    OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
    OR has_function_privilege('anon',p.oid,'EXECUTE')
    OR has_function_privilege('authenticated',p.oid,'EXECUTE')
    OR has_function_privilege('service_role',p.oid,'EXECUTE') THEN
   RAISE EXCEPTION 'reviewed private accepted-settlement validator dependency missing or changed';
 END IF;
END $accepted_receipt_dependency$;

CREATE SCHEMA ca_makegood;
REVOKE ALL ON SCHEMA ca_makegood FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE ca_makegood.policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 historical_receipt_cutoff timestamptz NOT NULL DEFAULT transaction_timestamp()
);
INSERT INTO ca_makegood.policy DEFAULT VALUES;
CREATE TABLE ca_makegood.funding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  funding_ledger_id uuid NOT NULL UNIQUE,
  amount numeric NOT NULL CHECK (amount > 0 AND amount = round(amount,2)
    AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
  source_fact jsonb NOT NULL,
  rationale text NOT NULL CHECK (length(btrim(rationale)) >= 80),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by name NOT NULL DEFAULT session_user
);
CREATE TABLE ca_makegood.debts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  wallet_club_id uuid NOT NULL REFERENCES public.clubs(id),
  kind text NOT NULL CHECK (kind IN ('place','refund','bounty','mystery_bounty')),
  source_identity text NOT NULL,
  asset text NOT NULL DEFAULT 'chips' CHECK (asset='chips'),
  UNIQUE(tournament_id,user_id,kind,source_identity,asset)
);
CREATE TABLE ca_makegood.revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  debt_id uuid NOT NULL REFERENCES ca_makegood.debts(id),
  revision bigint NOT NULL CHECK (revision > 0),
  previous_id uuid REFERENCES ca_makegood.revisions(id),
  recipe text NOT NULL,
  source_id uuid NOT NULL,
  total_entitlement numeric NOT NULL CHECK (total_entitlement >= 0
    AND total_entitlement = round(total_entitlement,2)
    AND total_entitlement::text NOT IN ('NaN','Infinity','-Infinity')),
  evidence jsonb NOT NULL,
  ordinary_receipts jsonb NOT NULL CHECK (jsonb_typeof(ordinary_receipts)='array'),
  ordinary_paid numeric NOT NULL CHECK (ordinary_paid >= 0 AND ordinary_paid=round(ordinary_paid,2)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(debt_id,revision)
);
CREATE TABLE ca_makegood.items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adjustment_id uuid NOT NULL UNIQUE REFERENCES public.ca_manual_adjustments(id),
  debt_id uuid NOT NULL REFERENCES ca_makegood.debts(id),
  revision_id uuid NOT NULL REFERENCES ca_makegood.revisions(id),
  funding_id uuid NOT NULL REFERENCES ca_makegood.funding(id),
  amount numeric NOT NULL CHECK (amount>0 AND amount=round(amount,2)
    AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(revision_id)
);
CREATE TABLE ca_makegood.receipts (
  item_id uuid PRIMARY KEY REFERENCES ca_makegood.items(id),
  debt_id uuid NOT NULL REFERENCES ca_makegood.debts(id),
  funding_id uuid NOT NULL REFERENCES ca_makegood.funding(id),
  ledger_id uuid NOT NULL UNIQUE,
  wallet_transaction_id uuid NOT NULL UNIQUE,
  amount numeric NOT NULL CHECK (amount>0 AND amount=round(amount,2)),
  receipt jsonb NOT NULL,
  paid_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX makegood_debt_receipts ON ca_makegood.receipts(debt_id);
CREATE INDEX makegood_funding_receipts ON ca_makegood.receipts(funding_id);

-- Ephemeral permits are created only inside the evidence-deriving payer. They
-- are bound to its SQL transaction/backend and exact immutable item, never GUCs.
CREATE TABLE ca_makegood.authorizations (
  item_id uuid PRIMARY KEY REFERENCES ca_makegood.items(id),
  transaction_id xid8 NOT NULL,
  backend_pid integer NOT NULL,
  wallet_transaction_id uuid NOT NULL UNIQUE,
  bank_before numeric NOT NULL,
  wallet_before numeric NOT NULL,
  terminal_before jsonb NOT NULL
);
ALTER TABLE ca_makegood.authorizations ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION ca_makegood.terminal_state(p_tournament uuid) RETURNS jsonb
LANGUAGE sql SET search_path=pg_catalog SET timezone='UTC' AS $$
 SELECT jsonb_build_object(
   'tournament',(SELECT to_jsonb(t) FROM public.tournaments t WHERE id=p_tournament),
   'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e WHERE tournament_id=p_tournament),
   'terminal',(SELECT jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text) FROM public.tournament_terminal_settlements r WHERE tournament_id=p_tournament),
   'satellite',(SELECT jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text) FROM public.tournament_satellite_settlements r WHERE tournament_id=p_tournament),
   'cancellation',(SELECT jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text) FROM public.tournament_cancellation_receipts r WHERE tournament_id=p_tournament))
$$;

CREATE FUNCTION ca_makegood.exact_funded_leg(p_row jsonb,p_wallet boolean)
RETURNS boolean LANGUAGE sql SET search_path=pg_catalog SET timezone='UTC' AS $$
 SELECT coalesce(EXISTS (
   SELECT 1 FROM ca_makegood.authorizations a
   JOIN ca_makegood.items i ON i.id=a.item_id
   JOIN ca_makegood.debts d ON d.id=i.debt_id
   JOIN ca_makegood.funding f ON f.id=i.funding_id
   JOIN public.clubs c ON c.id=f.club_id
   JOIN public.club_members m ON m.club_id=d.wallet_club_id AND m.user_id=d.user_id
   WHERE a.transaction_id=pg_current_xact_id() AND a.backend_pid=pg_backend_pid()
     AND c.chip_treasury=a.bank_before-i.amount AND m.chip_balance=a.wallet_before+i.amount
     AND i.amount>0 AND i.amount=round(i.amount,2)
     AND ca_makegood.terminal_state(d.tournament_id)=a.terminal_before
     AND p_row->>'terminal_closed_at' IS NULL
     AND CASE WHEN p_wallet THEN
       p_row @> jsonb_build_object('id',a.wallet_transaction_id,'user_id',d.user_id,
         'related_entity_id',d.tournament_id,'wallet_type','PLAYER','type','credit',
         'category','settlement','amount',i.amount,'balance_after',a.wallet_before+i.amount,
         'description','Audited house make-good item '||i.id)
       AND EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.idempotency_key=i.idempotency_key
         AND l.from_type='club_treasury' AND l.from_entity_id=f.club_id
         AND l.to_type='player_wallet' AND l.to_entity_id=d.user_id AND l.amount=i.amount
         AND l.club_id=d.wallet_club_id AND l.tournament_id=d.tournament_id AND l.category='adjustment' AND l.status='posted')
     ELSE p_row->'metadata'->>'satellite_id' IS NULL AND p_row @> jsonb_build_object('idempotency_key',i.idempotency_key,
       'from_type','club_treasury','from_entity_id',f.club_id,
       'to_type','player_wallet','to_entity_id',d.user_id,'amount',i.amount,
       'club_id',d.wallet_club_id,'tournament_id',d.tournament_id,'category','adjustment','status','posted')
     END),false)
$$;

-- The installed journal enrichment runs after terminal guards by trigger
-- name. Stamp this private item identity first; the matching permit, not an
-- ambient context string, provides the only candidate key.
CREATE FUNCTION ca_makegood.stamp_funded_item_key() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE candidate record; found_key text;
BEGIN
 IF NEW.idempotency_key IS NOT NULL OR NEW.category<>'adjustment' THEN RETURN NEW; END IF;
 FOR candidate IN SELECT i.idempotency_key FROM ca_makegood.authorizations a
   JOIN ca_makegood.items i ON i.id=a.item_id
   WHERE a.transaction_id=pg_current_xact_id() AND a.backend_pid=pg_backend_pid() LOOP
   IF ca_makegood.exact_funded_leg(to_jsonb(NEW)||jsonb_build_object('idempotency_key',candidate.idempotency_key),false) THEN
     IF found_key IS NOT NULL THEN RAISE EXCEPTION 'ambiguous funded item identity' USING ERRCODE='P0404'; END IF;
     found_key:=candidate.idempotency_key;
   END IF;
 END LOOP;
 IF found_key IS NOT NULL THEN NEW.idempotency_key:=found_key; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aa_ca_makegood_item_identity BEFORE INSERT ON public.chip_ledger
 FOR EACH ROW EXECUTE FUNCTION ca_makegood.stamp_funded_item_key();

CREATE FUNCTION ca_makegood.permit_must_finish() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE d ca_makegood.debts%ROWTYPE; i ca_makegood.items%ROWTYPE;
BEGIN
 SELECT * INTO i FROM ca_makegood.items WHERE id=NEW.item_id;
 SELECT * INTO d FROM ca_makegood.debts WHERE id=i.debt_id;
 IF EXISTS (SELECT 1 FROM ca_makegood.authorizations WHERE item_id=NEW.item_id)
    OR ca_makegood.terminal_state(d.tournament_id) IS DISTINCT FROM NEW.terminal_before
    OR NOT EXISTS (SELECT 1 FROM ca_makegood.receipts r
      JOIN ca_makegood.funding f ON f.id=i.funding_id
      JOIN public.chip_ledger l ON l.id=r.ledger_id
      JOIN public.wallet_transactions w ON w.id=r.wallet_transaction_id
      WHERE r.item_id=i.id AND r.debt_id=d.id AND r.funding_id=i.funding_id AND r.amount=i.amount
        AND r.wallet_transaction_id=NEW.wallet_transaction_id
        AND l.idempotency_key=i.idempotency_key AND l.from_type='club_treasury' AND l.from_entity_id=f.club_id
        AND l.to_type='player_wallet' AND l.to_entity_id=d.user_id AND l.amount=i.amount
        AND l.club_id=d.wallet_club_id AND l.tournament_id=d.tournament_id AND l.category='adjustment' AND l.status='posted'
        AND w.user_id=d.user_id AND w.related_entity_id=d.tournament_id AND w.amount=i.amount
        AND w.type='credit' AND w.category='settlement' AND w.wallet_type='PLAYER'
        AND w.balance_after=NEW.wallet_before+i.amount
        AND (r.receipt->>'bank_before')::numeric=NEW.bank_before
        AND (r.receipt->>'bank_after')::numeric=NEW.bank_before-i.amount
        AND (r.receipt->>'wallet_before')::numeric=NEW.wallet_before
        AND (r.receipt->>'wallet_after')::numeric=NEW.wallet_before+i.amount) THEN
   RAISE EXCEPTION 'house make-good authorization lacks its exact committed balanced receipt' USING ERRCODE='55000';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER makegood_permit_receipt AFTER INSERT ON ca_makegood.authorizations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ca_makegood.permit_must_finish();

-- Exact source provenance around the two canonical bounty call sites. Neither
-- context creation nor the helper is executable by a server/client role.
CREATE TABLE ca_makegood.ordinary_context (
 transaction_id xid8 NOT NULL, backend_pid integer NOT NULL, tournament_id uuid NOT NULL,
 user_id uuid NOT NULL, kind text NOT NULL, source_identity text NOT NULL,
 PRIMARY KEY(transaction_id,backend_pid,tournament_id,user_id,kind)
);
CREATE TABLE ca_makegood.ordinary_receipts (
 idempotency_key text PRIMARY KEY, ledger_id uuid NOT NULL UNIQUE,
 tournament_id uuid NOT NULL, user_id uuid NOT NULL, kind text NOT NULL,
 source_identity text NOT NULL, amount numeric NOT NULL CHECK(amount>0 AND amount=round(amount,2)),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE ca_makegood.ordinary_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE ca_makegood.ordinary_receipts ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION ca_makegood.settle_bounty_source(p_tournament uuid,p_kind text,p_user uuid,
 p_total numeric,p_source text,p_description text,p_identity text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE result jsonb; leg uuid; n integer; paid numeric; v_key text;
BEGIN
 PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament);
 PERFORM 1 FROM public.tournaments WHERE id=p_tournament FOR UPDATE;
 INSERT INTO ca_makegood.ordinary_context VALUES(pg_current_xact_id(),pg_backend_pid(),p_tournament,p_user,p_kind,p_identity);
 result:=public.fn_settle_tournament_obligation(p_tournament,p_kind,NULL,p_user,p_total,p_source,p_description);
 paid:=(result->>'paid')::numeric; v_key:=result->>'idempotency_key';
 IF paid>0 THEN
   SELECT count(*),min(l.id::text)::uuid INTO n,leg FROM public.chip_ledger l
    JOIN public.wallet_credit_idempotency k ON k.key=l.idempotency_key
    WHERE k.key=v_key AND k.user_id=p_user AND k.amount=paid
      AND l.tournament_id=p_tournament AND l.to_type='player_wallet'
      AND l.to_entity_id=p_user AND l.amount=paid AND l.status='posted';
   IF n<>1 THEN RAISE EXCEPTION 'bounty source payment lacks its exact keyed leg' USING ERRCODE='P0404'; END IF;
   INSERT INTO ca_makegood.ordinary_receipts(idempotency_key,ledger_id,tournament_id,user_id,kind,source_identity,amount)
     VALUES(v_key,leg,p_tournament,p_user,p_kind,p_identity,paid);
 END IF;
 DELETE FROM ca_makegood.ordinary_context WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid()
   AND tournament_id=p_tournament AND user_id=p_user AND kind=p_kind;
 RETURN result;
END $$;

CREATE FUNCTION ca_makegood.immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN RAISE EXCEPTION 'make-good evidence, items and receipts are append-only' USING ERRCODE='55000'; END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['policy','funding','debts','revisions','items','receipts','ordinary_receipts'] LOOP
    EXECUTE format('ALTER TABLE ca_makegood.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ca_makegood.%I FOR EACH STATEMENT EXECUTE FUNCTION ca_makegood.immutable()',t);
  END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA ca_makegood FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ca_makegood FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION ca_makegood.assert_server() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
  -- SQL privilege is the authority. JWT text is deliberately not an ACL.
  -- PostgREST SET ROLE survives SECURITY DEFINER in the role setting.
  IF NOT (session_user='service_role'
      OR current_setting('role',true)='service_role'
      OR (session_user='postgres' AND current_setting('role',true) IN ('none','postgres'))) THEN
    RAISE EXCEPTION 'authenticated server authority required' USING ERRCODE='42501';
  END IF;
END $$;

-- Historical receipts are separately qualified, never retroactively keyed.
-- The pre-installation, exact transaction-timestamp tuple must be one-to-one
-- across payout, claimed key, receiving-wallet ledger and wallet transaction.
CREATE FUNCTION ca_makegood.place_receipts(p_tournament uuid,p_user uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE p record; k record; l record; w public.wallet_transactions%ROWTYPE; n integer; result jsonb:='[]'; mode text;
BEGIN
 IF EXISTS (SELECT 1 FROM public.tournament_payouts WHERE tournament_id=p_tournament AND user_id=p_user
      AND (source IS NULL OR source NOT IN ('structure','reconcile','late_reg_adjustment','finish_position_correction','final_table_deal','hu_shortfall','spin_backpay','overlay_backpay'))) THEN
   RAISE EXCEPTION 'ordinary place payment class is not exhaustively proven' USING ERRCODE='P0404'; END IF;
 IF (SELECT coalesce(sum(amount),0) FROM public.wallet_transactions WHERE related_entity_id=p_tournament
      AND user_id=p_user AND type='credit' AND lower(category)='prize')
    IS DISTINCT FROM (SELECT coalesce(sum(amount),0) FROM public.tournament_payouts
      WHERE tournament_id=p_tournament AND user_id=p_user) THEN
   RAISE EXCEPTION 'ordinary place wallet evidence is not exhaustively classified' USING ERRCODE='P0404'; END IF;
 FOR p IN SELECT * FROM public.tournament_payouts WHERE tournament_id=p_tournament AND user_id=p_user
    AND source IN ('structure','reconcile','late_reg_adjustment','finish_position_correction','final_table_deal','hu_shortfall','spin_backpay','overlay_backpay') ORDER BY id LOOP
   SELECT * INTO k FROM public.wallet_credit_idempotency WHERE key=p.idempotency_key AND user_id=p_user AND amount=p.amount;
   IF NOT FOUND THEN RAISE EXCEPTION 'ordinary place payment lacks exact credit and ledger evidence' USING ERRCODE='P0404'; END IF;
   SELECT count(*) INTO n FROM public.chip_ledger x WHERE x.idempotency_key=k.key
     AND x.tournament_id=p_tournament AND x.from_type='prize_liability' AND x.from_entity_id=p_tournament
     AND x.to_type='player_wallet' AND x.to_entity_id=p_user AND x.amount=p.amount AND x.status='posted'
     AND x.category='tournament_prize' AND x.club_id IS NOT NULL;
   IF n=1 THEN
     SELECT * INTO l FROM public.chip_ledger x WHERE x.idempotency_key=k.key
       AND x.tournament_id=p_tournament AND x.from_type='prize_liability' AND x.from_entity_id=p_tournament
       AND x.to_type='player_wallet' AND x.to_entity_id=p_user AND x.amount=p.amount AND x.status='posted'
       AND x.category='tournament_prize' AND x.club_id IS NOT NULL;
     mode:='keyed_receiving_wallet';
   ELSIF n=0 AND p.paid_at < (SELECT historical_receipt_cutoff FROM ca_makegood.policy)
       AND p.paid_at=p.created_at AND k.created_at=p.paid_at THEN
     SELECT count(*) INTO n FROM public.chip_ledger x WHERE x.idempotency_key IS NULL
       AND x.tournament_id=p_tournament AND x.from_type='prize_liability' AND x.from_entity_id=p_tournament
       AND x.to_type='player_wallet' AND x.to_entity_id=p_user AND x.amount=p.amount AND x.status='posted'
       AND x.category='tournament_prize' AND x.created_at=p.paid_at
       AND x.club_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id=x.club_id);
     IF n<>1 THEN RAISE EXCEPTION 'historical receiving-wallet leg is absent or ambiguous' USING ERRCODE='P0404'; END IF;
     SELECT * INTO l FROM public.chip_ledger x WHERE x.idempotency_key IS NULL
       AND x.tournament_id=p_tournament AND x.from_type='prize_liability' AND x.from_entity_id=p_tournament
       AND x.to_type='player_wallet' AND x.to_entity_id=p_user AND x.amount=p.amount AND x.status='posted'
       AND x.category='tournament_prize' AND x.created_at=p.paid_at
       AND x.club_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id=x.club_id);
     SELECT count(*) INTO n FROM public.wallet_transactions x WHERE x.related_entity_id=p_tournament AND x.user_id=p_user
       AND x.type='credit' AND x.category='prize' AND x.amount=p.amount AND x.created_at=p.paid_at;
     IF n<>1 OR (SELECT count(*) FROM public.tournament_payouts x WHERE x.tournament_id=p_tournament AND x.user_id=p_user
       AND x.amount=p.amount AND x.paid_at=p.paid_at)<>1 THEN
       RAISE EXCEPTION 'historical payout and wallet tuple is absent or ambiguous' USING ERRCODE='P0404'; END IF;
     SELECT * INTO w FROM public.wallet_transactions x WHERE x.related_entity_id=p_tournament AND x.user_id=p_user
       AND x.type='credit' AND x.category='prize' AND x.amount=p.amount AND x.created_at=p.paid_at;
     mode:='historical_unique_transaction_tuple';
   ELSE RAISE EXCEPTION 'ordinary place payment lacks exact credit and ledger evidence' USING ERRCODE='P0404';
   END IF;
   result:=result||jsonb_build_array(jsonb_build_object('payout_id',p.id,'key',k.key,'ledger_id',l.id,
     'wallet_transaction_id',CASE WHEN mode='historical_unique_transaction_tuple' THEN w.id ELSE NULL END,
     'amount',p.amount,'proof',mode,'paid_at',p.paid_at,'receiving_wallet_club_id',l.club_id));
 END LOOP;
 RETURN result;
END $$;

CREATE FUNCTION ca_makegood.true_place(p_entry uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE player public.tournament_players%ROWTYPE; busted jsonb; total_players integer; winner uuid;
 witness jsonb; price numeric; ranked integer; qualified jsonb; winner_fact jsonb; zero_history jsonb;
BEGIN
 SELECT * INTO player FROM public.tournament_players WHERE id=p_entry;
 IF NOT FOUND THEN RAISE EXCEPTION 'tournament entry missing' USING ERRCODE='P0404'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id=player.tournament_id AND t.status='COMPLETED'
       AND NOT coalesce(t.is_bounty,false) AND NOT coalesce(t.is_pko,false) AND NOT coalesce(t.is_mystery_bounty,false)
       AND t.satellite_target_id IS NULL)
    OR NOT EXISTS (SELECT 1 FROM public.tournament_terminal_settlements r JOIN public.tournaments t ON t.id=r.tournament_id
       WHERE r.tournament_id=player.tournament_id AND r.prize_pool=t.prize_pool AND r.settlement_mode='places') THEN
   RAISE EXCEPTION 'true-order make-good requires its restored contract and committed normal terminal receipt' USING ERRCODE='P0404'; END IF;
 SELECT count(*),min(user_id::text)::uuid INTO total_players,winner FROM public.tournament_players WHERE tournament_id=player.tournament_id AND status='winner';
 IF total_players<>1 OR NOT EXISTS (SELECT 1 FROM public.tournament_terminal_settlements r
     WHERE r.tournament_id=player.tournament_id AND r.winner_id=winner) THEN
   RAISE EXCEPTION 'canonical winner witness is ambiguous' USING ERRCODE='P0404'; END IF;
 SELECT count(*) INTO total_players FROM public.tournament_players WHERE tournament_id=player.tournament_id;
 -- Feed only exact persisted rows to the shared pure qualifier. A failed SQL
 -- attempt cannot prove a bust, survivor or monetary entitlement.
 SELECT coalesce(jsonb_agg(public.fn_ca_accepted_tournament_settlement_fact(to_jsonb(k))
     ORDER BY k.completed_at,k.table_id,k.hand_id),'[]') INTO qualified
 FROM public.settlement_idempotency_keys k JOIN public.tables t ON t.id=k.table_id
 WHERE t.tournament_id=player.tournament_id AND k.status='succeeded';
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(qualified) q WHERE q->'ok' IS DISTINCT FROM 'true'::jsonb)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(qualified) q, jsonb_array_elements(q->'facts') f
       WHERE NOT EXISTS (SELECT 1 FROM public.tournament_players tp
         WHERE tp.tournament_id=player.tournament_id AND tp.user_id::text=f->>'user_id'))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(qualified) q
       GROUP BY q->>'table_id',q->>'hand_number' HAVING count(*)<>1) THEN
   RAISE EXCEPTION 'accepted true-order source is malformed, foreign or ambiguous' USING ERRCODE='P0404'; END IF;
 -- This recipe has no independently proved reentry-generation adapter. Keep
 -- every positive-to-zero receipt visible: choosing only the latest bust must
 -- not hide an earlier zero followed by a new positive stack or purchase.
 SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',f->'user_id','completed_at',q->'completed_at')),'[]')
 INTO zero_history FROM jsonb_array_elements(qualified) q,jsonb_array_elements(q->'facts') f
 WHERE (f->>'stack_before')::numeric>0 AND (f->>'stack')::numeric=0;
 WITH accepted AS (
   SELECT (f->>'user_id')::uuid user_id,q,
     (q->>'completed_at')::timestamptz completed_at,(f->>'stack_before')::numeric stack_before,
     row_number() OVER(PARTITION BY f->>'user_id' ORDER BY (q->>'completed_at')::timestamptz DESC,q->>'hand_id' DESC) rn
   FROM jsonb_array_elements(qualified) q, jsonb_array_elements(q->'facts') f
   WHERE f->>'user_id'<>winner::text AND (f->>'stack_before')::numeric>0 AND (f->>'stack')::numeric=0
 ), ordered AS (
   SELECT *,1+row_number() OVER(ORDER BY completed_at DESC,stack_before DESC) AS true_place
   FROM accepted WHERE rn=1
 ) SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'table_id',q->'table_id','settlement_id',q->'hand_id',
     'hand_number',q->'hand_number','completed_at',completed_at,'stack_before',stack_before,'true_place',true_place,
     'source_sha256',q->'source_sha256')
     ORDER BY true_place) INTO busted FROM ordered;
 IF coalesce(jsonb_array_length(busted),0)<>total_players-1 THEN
   RAISE EXCEPTION 'accepted true-order roster is incomplete' USING ERRCODE='P0404'; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(busted) b
     GROUP BY b->>'table_id',b->>'settlement_id',b->>'stack_before' HAVING count(*)>1) THEN
   RAISE EXCEPTION 'same-hand equal starting stacks require an authoritative tie allocation' USING ERRCODE='P0404'; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(zero_history) b, jsonb_array_elements(qualified) q,
      jsonb_array_elements(q->'facts') f WHERE f->>'user_id'=b->>'user_id' AND (f->>'stack')::numeric>0
      AND (q->>'completed_at')::timestamptz >= (b->>'completed_at')::timestamptz)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(busted) a,jsonb_array_elements(busted) b
      WHERE a->>'completed_at'=b->>'completed_at' AND a->>'settlement_id'<>b->>'settlement_id') THEN
   RAISE EXCEPTION 'accepted bust is followed by positive play or has ambiguous hand ordering' USING ERRCODE='P0404'; END IF;
 SELECT q||jsonb_build_object('winner_stack',f->'stack') INTO winner_fact
 FROM jsonb_array_elements(qualified) q,jsonb_array_elements(q->'facts') f WHERE f->>'user_id'=winner::text
 ORDER BY (q->>'completed_at')::timestamptz DESC,q->>'hand_id' DESC LIMIT 1;
 IF winner_fact IS NULL OR (winner_fact->>'winner_stack')::numeric<=0
    OR (winner_fact->>'completed_at')::timestamptz < (SELECT max((b->>'completed_at')::timestamptz) FROM jsonb_array_elements(busted) b) THEN
   RAISE EXCEPTION 'canonical winner lacks a latest positive accepted stack' USING ERRCODE='P0404'; END IF;
 IF EXISTS (
   SELECT 1 FROM jsonb_array_elements(zero_history||jsonb_build_array(jsonb_build_object(
       'user_id',winner,'completed_at',winner_fact->'completed_at'))) b
   WHERE EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=player.tournament_id
       AND tp.user_id::text=b->>'user_id' AND (tp.registered_at IS NULL OR NOT isfinite(tp.registered_at)
         OR tp.registered_at>(b->>'completed_at')::timestamptz))
      OR EXISTS (SELECT 1 FROM public.tournament_refund_entitlements e
       LEFT JOIN public.chip_ledger l ON l.id=e.source_ledger_id
       WHERE e.tournament_id=player.tournament_id AND e.entitlement_kind='wallet_charge'
       AND e.user_id::text=b->>'user_id' AND (l.id IS NULL OR l.created_at>(b->>'completed_at')::timestamptz))
      OR EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.tournament_id=player.tournament_id
       AND l.from_type='player_wallet' AND l.from_entity_id::text=b->>'user_id' AND l.status='posted'
       AND l.category IN ('tournament_buyin','rebuy','addon') AND l.created_at>(b->>'completed_at')::timestamptz)
      OR EXISTS (SELECT 1 FROM public.wallet_transactions w WHERE w.related_entity_id=player.tournament_id
       AND w.user_id::text=b->>'user_id' AND w.type='debit' AND lower(w.category) IN ('tournament_buyin','rebuy','addon')
       AND w.created_at>(b->>'completed_at')::timestamptz)) THEN
   RAISE EXCEPTION 'accepted final stack is followed by an entry or chip purchase' USING ERRCODE='P0404'; END IF;
 SELECT value INTO witness FROM jsonb_array_elements(busted) WHERE value->>'user_id'=player.user_id::text;
 ranked:=CASE WHEN player.user_id=winner THEN 1 ELSE (witness->>'true_place')::integer END;
 SELECT amount INTO price FROM public.fn_ca_tournament_place_amounts(player.tournament_id) WHERE place=ranked;
 price:=coalesce(price,0);
 RETURN jsonb_build_object('tournament_id',player.tournament_id,'user_id',player.user_id,'wallet_club_id',player.club_id,
   'total_entitlement',price,'evidence',jsonb_build_object('entry_id',player.id,'true_place',ranked,
      'bust',witness,'ordered_roster',busted,'winner_fact',winner_fact,
      'accepted_source_hashes',(SELECT jsonb_agg(q->'source_sha256' ORDER BY q->>'source_sha256') FROM jsonb_array_elements(qualified) q),
      'contract',(SELECT payout_structure FROM public.tournaments WHERE id=player.tournament_id)));
END $$;

-- Each recipe derives identity, recipient, denomination, entitlement and original
-- payment facts from authoritative tables. A source that does not satisfy these
-- predicates remains ineligible; the caller cannot supply a replacement total.
CREATE FUNCTION ca_makegood.derive(p_recipe text,p_source uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE s record; t record; receipts jsonb := '[]'; amount numeric; paid numeric;
  v_kind text; identity text; evidence jsonb; wallet uuid;
BEGIN
  IF p_recipe='true_bust_place' THEN
    evidence:=ca_makegood.true_place(p_source);
    SELECT (evidence->>'tournament_id')::uuid AS tournament_id,(evidence->>'user_id')::uuid AS user_id INTO s;
    amount:=(evidence->>'total_entitlement')::numeric;wallet:=(evidence->>'wallet_club_id')::uuid;
    evidence:=evidence->'evidence';v_kind:='place';identity:='event-place-entitlement';
    receipts:=ca_makegood.place_receipts(s.tournament_id,s.user_id);
  ELSIF p_recipe='place_obligation' THEN
    SELECT o.*,tp.club_id AS wallet_club_id INTO s
      FROM public.tournament_obligations o JOIN public.tournament_players tp
        ON tp.tournament_id=o.tournament_id AND tp.user_id=o.user_id
      WHERE o.id=p_source AND o.kind='place';
    IF NOT FOUND THEN RAISE EXCEPTION 'place obligation source missing' USING ERRCODE='P0404'; END IF;
    SELECT a.amount INTO amount FROM public.fn_ca_tournament_place_amounts(s.tournament_id) a WHERE a.place=s.place;
    IF amount IS NULL OR amount IS DISTINCT FROM s.amount_owed THEN
      RAISE EXCEPTION 'place obligation differs from the canonical locked ladder' USING ERRCODE='P0404';
    END IF;
    v_kind:='place'; identity:='event-place-entitlement'; wallet:=s.wallet_club_id;
    evidence:=jsonb_build_object('obligation_id',s.id,'place',s.place,'amount',amount);
    receipts:=ca_makegood.place_receipts(s.tournament_id,s.user_id);
  ELSIF p_recipe='undelivered_rebuy' THEN
    SELECT e.*,e.refund_wallet_club_id AS wallet_club_id INTO s
      FROM public.tournament_refund_entitlements e JOIN public.chip_ledger l ON l.id=e.source_ledger_id
      WHERE e.source_ledger_id=p_source AND e.entitlement_kind='wallet_charge'
        AND e.charge_category='rebuy' AND l.category='rebuy' AND l.status='posted'
        AND l.tournament_id=e.tournament_id AND l.from_type='player_wallet'
        AND l.from_entity_id=e.user_id AND l.to_type='prize_liability'
        AND l.to_entity_id=e.tournament_id AND l.club_id=e.refund_wallet_club_id AND l.amount=e.gross;
    IF NOT FOUND THEN RAISE EXCEPTION 'exact rebuy debit entitlement missing' USING ERRCODE='P0404'; END IF;
    -- Deliberately excludes the four delivered-once/double-charge cases: they
    -- need their own exact allocation witness, never this negative inference.
    IF NOT EXISTS (SELECT 1 FROM public.tournaments q WHERE q.id=s.tournament_id AND q.status='COMPLETED')
       OR NOT EXISTS (SELECT 1 FROM public.chip_ledger l
          JOIN public.tournament_knockout_candidates c ON c.tournament_id=l.tournament_id AND c.eliminated_user_id=s.user_id
          JOIN public.hand_atomic_commits h ON h.table_id=c.table_id AND h.hand_id=c.hand_id AND h.hand_number=c.hand_number
          WHERE l.id=p_source AND c.state='eliminated' AND h.committed_at < l.created_at)
       OR EXISTS (SELECT 1 FROM public.hand_history h JOIN public.chip_ledger l ON l.id=p_source
          WHERE h.tournament_id=s.tournament_id AND h.created_at>=l.created_at
            AND (h.players @> jsonb_build_array(jsonb_build_object('userId',s.user_id::text))
              OR h.players @> jsonb_build_array(jsonb_build_object('user_id',s.user_id::text))))
       OR EXISTS (SELECT 1 FROM public.table_seats seat JOIN public.tables tb ON tb.id=seat.table_id
          JOIN public.chip_ledger l ON l.id=p_source
          WHERE tb.tournament_id=s.tournament_id AND seat.user_id=s.user_id
            AND (seat.left_at IS NULL OR seat.left_at>l.created_at)) THEN
      RAISE EXCEPTION 'no-delivery witness is incomplete or the event is not terminal' USING ERRCODE='P0404';
    END IF;
    amount:=s.gross;v_kind:='refund';identity:='charge:'||s.source_ledger_id;wallet:=s.wallet_club_id;
    evidence:=to_jsonb(s);
    SELECT coalesce(jsonb_agg(jsonb_build_object('key',r.idempotency_key,'ledger_id',r.credit_ledger_id,
      'wallet_transaction_id',r.wallet_transaction_id,'amount',r.amount_paid_now) ORDER BY r.wallet_transaction_id),'[]')
      INTO receipts FROM public.tournament_refund_tranches r
      JOIN public.wallet_credit_idempotency k ON k.key=r.idempotency_key AND k.user_id=r.user_id AND k.amount=r.amount_paid_now
      JOIN public.chip_ledger l ON l.id=r.credit_ledger_id AND l.amount=r.amount_paid_now AND l.to_entity_id=r.user_id
        AND l.to_type='player_wallet' AND l.from_type='prize_liability' AND l.from_entity_id=r.tournament_id
        AND l.tournament_id=r.tournament_id AND l.club_id=s.wallet_club_id AND l.status='posted'
      JOIN public.wallet_transactions w ON w.id=r.wallet_transaction_id AND w.user_id=r.user_id
        AND w.related_entity_id=r.tournament_id AND w.amount=r.amount_paid_now AND w.type='credit' AND lower(w.category) IN ('refund','tournament_refund')
      WHERE r.entitlement_id=s.id;
    IF (SELECT count(*) FROM public.tournament_refund_tranches r WHERE r.entitlement_id=s.id)<>jsonb_array_length(receipts) THEN
      RAISE EXCEPTION 'refund tranche payment evidence differs' USING ERRCODE='P0404';
    END IF;
  ELSIF p_recipe='knockout_record' THEN
    SELECT b.*,b.collector_player_id AS user_id,tp.club_id AS wallet_club_id INTO s
      FROM public.tournament_bounties b JOIN public.tournament_players tp
        ON tp.tournament_id=b.tournament_id AND tp.user_id=b.collector_player_id
      WHERE b.id=p_source AND NOT coalesce(b.is_mystery_revealed,false);
    IF NOT FOUND THEN RAISE EXCEPTION 'knockout cash source missing' USING ERRCODE='P0404'; END IF;
    IF s.bounty_obligation_id IS NULL THEN
      RAISE EXCEPTION 'legacy knockout generation is unproven; exact obligation identity required' USING ERRCODE='P0404'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.tournament_bounty_obligations o WHERE o.id=s.bounty_obligation_id
        AND o.tournament_id=s.tournament_id AND o.eliminated_user_id=s.eliminated_player_id
        AND o.state='settled' AND o.mode<>'mystery_chest'
        AND public.fn_bounty_obligation_has_complete_marker(o.id)) THEN
      RAISE EXCEPTION 'knockout cash source lacks its complete canonical allocation witness' USING ERRCODE='P0404'; END IF;
    amount:=s.bounty_amount-coalesce(s.added_to_collector_bounty,0);
    v_kind:='bounty';identity:='knockout:'||coalesce(s.bounty_obligation_id::text,s.eliminated_player_id::text);wallet:=s.wallet_club_id;
    evidence:=to_jsonb(s);
  ELSIF p_recipe='mystery_recipient' THEN
    SELECT r.*,a.tournament_id,a.eliminated_user_id,a.status AS award_status,tp.club_id AS wallet_club_id INTO s
      FROM public.tournament_bounty_award_recipients r JOIN public.tournament_bounty_awards a ON a.id=r.award_id
      JOIN public.tournament_players tp ON tp.tournament_id=a.tournament_id AND tp.user_id=r.user_id
      WHERE r.id=p_source AND a.status IN ('revealed','paid','completed');
    IF NOT FOUND THEN RAISE EXCEPTION 'revealed mystery recipient source missing' USING ERRCODE='P0404'; END IF;
    amount:=s.amount_cents::numeric/100;v_kind:='mystery_bounty';identity:='award:'||s.award_id;wallet:=s.wallet_club_id;
    evidence:=to_jsonb(s);
  ELSE RAISE EXCEPTION 'unsupported make-good evidence recipe %',p_recipe USING ERRCODE='22023';
  END IF;
  IF v_kind IN ('bounty','mystery_bounty') THEN
    -- Every ordinary cash receipt must carry its own exact source provenance.
    -- Aggregate legacy payment counters cannot be assigned to a KO or award.
    IF NOT EXISTS (SELECT 1 FROM public.tournaments q WHERE q.id=s.tournament_id AND q.status='COMPLETED')
       OR EXISTS (SELECT 1 FROM public.tournament_obligations o WHERE o.tournament_id=s.tournament_id
         AND o.user_id=s.user_id AND o.kind=v_kind AND o.amount_paid<>(SELECT coalesce(sum(r.amount),0)
           FROM ca_makegood.ordinary_receipts r WHERE r.tournament_id=o.tournament_id AND r.user_id=o.user_id AND r.kind=o.kind))
       OR (SELECT coalesce(sum(w.amount),0) FROM public.wallet_transactions w WHERE w.related_entity_id=s.tournament_id
           AND w.user_id=s.user_id AND w.type='credit' AND lower(w.category) IN ('bounty','mystery_bounty'))
          IS DISTINCT FROM (SELECT coalesce(sum(r.amount),0) FROM ca_makegood.ordinary_receipts r
           WHERE r.tournament_id=s.tournament_id AND r.user_id=s.user_id AND r.kind IN ('bounty','mystery_bounty'))
       OR EXISTS (SELECT 1 FROM public.tournament_payouts p WHERE p.tournament_id=s.tournament_id AND p.user_id=s.user_id
         AND p.source=v_kind AND NOT EXISTS (SELECT 1 FROM ca_makegood.ordinary_receipts r WHERE r.idempotency_key=p.idempotency_key AND r.amount=p.amount)) THEN
      RAISE EXCEPTION 'terminal exact-source bounty receipt evidence required; legacy aggregate attribution is unsupported' USING ERRCODE='P0404';
    END IF;
    SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.idempotency_key),'[]') INTO receipts
      FROM ca_makegood.ordinary_receipts r WHERE r.tournament_id=s.tournament_id AND r.user_id=s.user_id
        AND r.kind=v_kind AND r.source_identity=identity;
  END IF;
  IF wallet IS NULL OR amount IS NULL OR amount<0 OR amount<>round(amount,2)
     OR amount::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'invalid source wallet or exact entitlement' USING ERRCODE='22003';
  END IF;
  SELECT coalesce(sum((r->>'amount')::numeric),0) INTO paid FROM jsonb_array_elements(receipts) r;
  RETURN jsonb_build_object('tournament_id',s.tournament_id,'user_id',s.user_id,'wallet_club_id',wallet,
    'kind',v_kind,'source_identity',identity,'total_entitlement',amount,'evidence',evidence,
    'ordinary_receipts',receipts,'ordinary_paid',paid);
END $$;

CREATE FUNCTION public.fn_ca_makegood_register_funding(p_ledger_id uuid,p_rationale text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE l public.chip_ledger%ROWTYPE; result uuid;
BEGIN
  PERFORM ca_makegood.assert_server();
  SELECT * INTO l FROM public.chip_ledger WHERE id=p_ledger_id;
  IF NOT FOUND OR l.to_type<>'club_treasury' OR l.to_entity_id IS NULL
     OR l.from_type IN ('prize_liability','bounty_liability','settlement_suspense')
     OR l.status<>'posted' OR l.amount<=0 OR l.amount<>round(l.amount,2)
     OR l.amount::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'verified funded house treasury receipt required' USING ERRCODE='P0404';
  END IF;
  IF p_rationale IS NULL OR length(btrim(p_rationale))<80 THEN RAISE EXCEPTION 'funding rationale required' USING ERRCODE='22023'; END IF;
  SELECT id INTO result FROM ca_makegood.funding WHERE funding_ledger_id=l.id;
  IF FOUND THEN RETURN result; END IF;
  PERFORM 1 FROM public.clubs c WHERE c.id=l.to_entity_id AND c.chip_treasury>=l.amount FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'house treasury does not hold the verified funding amount' USING ERRCODE='P0404'; END IF;
  INSERT INTO ca_makegood.funding(club_id,funding_ledger_id,amount,source_fact,rationale)
    VALUES(l.to_entity_id,l.id,l.amount,to_jsonb(l),btrim(p_rationale))
    ON CONFLICT(funding_ledger_id) DO NOTHING RETURNING id INTO result;
  IF result IS NULL THEN SELECT id INTO result FROM ca_makegood.funding WHERE funding_ledger_id=l.id; END IF;
  RETURN result;
END $$;

CREATE FUNCTION public.fn_ca_makegood_propose(p_recipe text,p_source_id uuid,p_funding_id uuid,
  p_expected_net numeric,p_reason text,p_import_adjustment_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE fact jsonb; d ca_makegood.debts%ROWTYPE; prev ca_makegood.revisions%ROWTYPE;
  rev uuid; item uuid:=gen_random_uuid(); adj uuid; net numeric; paid numeric; existing ca_makegood.items%ROWTYPE;
BEGIN
  PERFORM ca_makegood.assert_server();
  IF p_reason IS NULL OR length(btrim(p_reason))<80 OR p_expected_net IS NULL
     OR p_expected_net<0 OR p_expected_net<>round(p_expected_net,2)
     OR p_expected_net::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'exact nonnegative net assertion and evidence rationale required' USING ERRCODE='22003'; END IF;
  -- Resolve immutable source identity without taking a row lock; lane locks
  -- must precede fn_ca_tournament_place_amounts' tournament FOR UPDATE.
  IF p_recipe='true_bust_place' THEN
    SELECT jsonb_build_object('tournament_id',tournament_id) INTO fact FROM public.tournament_players WHERE id=p_source_id;
  ELSIF p_recipe='place_obligation' THEN
    SELECT jsonb_build_object('tournament_id',tournament_id) INTO fact FROM public.tournament_obligations WHERE id=p_source_id;
  ELSIF p_recipe='undelivered_rebuy' THEN
    SELECT jsonb_build_object('tournament_id',tournament_id) INTO fact FROM public.tournament_refund_entitlements WHERE source_ledger_id=p_source_id;
  ELSIF p_recipe='knockout_record' THEN
    SELECT jsonb_build_object('tournament_id',tournament_id) INTO fact FROM public.tournament_bounties WHERE id=p_source_id;
  ELSIF p_recipe='mystery_recipient' THEN
    SELECT jsonb_build_object('tournament_id',a.tournament_id) INTO fact FROM public.tournament_bounty_award_recipients r JOIN public.tournament_bounty_awards a ON a.id=r.award_id WHERE r.id=p_source_id;
  END IF;
  IF fact IS NULL THEN RAISE EXCEPTION 'supported source identity missing' USING ERRCODE='P0404'; END IF;
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament((fact->>'tournament_id')::uuid);
  PERFORM 1 FROM public.tournaments WHERE id=(fact->>'tournament_id')::uuid FOR UPDATE;
  fact:=ca_makegood.derive(p_recipe,p_source_id);
  IF NOT EXISTS (SELECT 1 FROM ca_makegood.funding WHERE id=p_funding_id) THEN RAISE EXCEPTION 'funding authorization missing' USING ERRCODE='P0404'; END IF;
  INSERT INTO ca_makegood.debts(tournament_id,user_id,wallet_club_id,kind,source_identity)
    VALUES((fact->>'tournament_id')::uuid,(fact->>'user_id')::uuid,(fact->>'wallet_club_id')::uuid,fact->>'kind',fact->>'source_identity')
    ON CONFLICT(tournament_id,user_id,kind,source_identity,asset) DO NOTHING;
  SELECT * INTO d FROM ca_makegood.debts WHERE tournament_id=(fact->>'tournament_id')::uuid
    AND user_id=(fact->>'user_id')::uuid AND kind=fact->>'kind' AND source_identity=fact->>'source_identity' AND asset='chips' FOR UPDATE;
  IF d.wallet_club_id IS DISTINCT FROM (fact->>'wallet_club_id')::uuid THEN RAISE EXCEPTION 'debt wallet identity changed' USING ERRCODE='P0404'; END IF;
  SELECT * INTO prev FROM ca_makegood.revisions WHERE debt_id=d.id ORDER BY revision DESC LIMIT 1;
  SELECT coalesce(sum(r.amount),0) INTO paid FROM ca_makegood.receipts r WHERE r.debt_id=d.id;
  net:=greatest(0,(fact->>'total_entitlement')::numeric-(fact->>'ordinary_paid')::numeric-paid);
  IF prev.evidence IS NOT DISTINCT FROM fact->'evidence' AND prev.ordinary_receipts IS NOT DISTINCT FROM fact->'ordinary_receipts'
     AND prev.total_entitlement IS NOT DISTINCT FROM (fact->>'total_entitlement')::numeric THEN
    SELECT * INTO existing FROM ca_makegood.items WHERE revision_id=prev.id;
    IF existing.id IS NOT NULL THEN
      IF existing.amount IS DISTINCT FROM p_expected_net OR existing.funding_id IS DISTINCT FROM p_funding_id
         OR (p_import_adjustment_id IS NOT NULL AND existing.adjustment_id<>p_import_adjustment_id) THEN
        RAISE EXCEPTION 'existing debt item differs; immutable item cannot be amended' USING ERRCODE='23505';
      END IF;
      RETURN jsonb_build_object('item_id',existing.id,'adjustment_id',existing.adjustment_id,'replayed',true);
    END IF;
  END IF;
  -- Record downward revisions too, but create no clawback or zero item.
  INSERT INTO ca_makegood.revisions(debt_id,revision,previous_id,recipe,source_id,total_entitlement,evidence,ordinary_receipts,ordinary_paid)
    VALUES(d.id,coalesce(prev.revision,0)+1,prev.id,p_recipe,p_source_id,(fact->>'total_entitlement')::numeric,
      fact->'evidence',fact->'ordinary_receipts',(fact->>'ordinary_paid')::numeric) RETURNING id INTO rev;
  IF net=0 AND p_expected_net<>0 THEN RAISE EXCEPTION 'no positive unpaid entitlement remains' USING ERRCODE='P0404'; END IF;
  IF net=0 THEN RETURN jsonb_build_object('debt_id',d.id,'revision_id',rev,'remaining',0,'item_id',NULL); END IF;
  IF net<>p_expected_net THEN RAISE EXCEPTION 'net assertion differs: validated total %, ordinary paid %, make-good paid %, remaining %',fact->>'total_entitlement',fact->>'ordinary_paid',paid,net USING ERRCODE='P0404'; END IF;
  IF p_import_adjustment_id IS NULL THEN
    INSERT INTO public.ca_manual_adjustments(actor,actor_label,reason,amount,target_kind,target_id,tournament_id,status,asset)
      VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d','authenticated server evidence authority',btrim(p_reason),net,
        'player_wallet',d.user_id,d.tournament_id,'proposed','chips') RETURNING id INTO adj;
  ELSE
    SELECT id INTO adj FROM public.ca_manual_adjustments WHERE id=p_import_adjustment_id AND status='proposed'
      AND asset='chips' AND target_kind='player_wallet' AND target_id=d.user_id AND tournament_id=d.tournament_id AND amount=net FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'imported net proposal differs from derived remaining entitlement' USING ERRCODE='P0404'; END IF;
  END IF;
  INSERT INTO ca_makegood.items(id,adjustment_id,debt_id,revision_id,funding_id,amount,idempotency_key)
    VALUES(item,adj,d.id,rev,p_funding_id,net,'makegood:'||item);
  RETURN jsonb_build_object('item_id',item,'adjustment_id',adj,'debt_id',d.id,'revision_id',rev,'total_entitlement',fact->'total_entitlement','ordinary_paid',fact->'ordinary_paid','amount',net);
END $$;

-- A linked proposal is immutable, including after payment. Payment state lives
-- in the append-only receipt; four-eyes records retain their existing contract.
CREATE FUNCTION ca_makegood.protect_adjustment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM ca_makegood.items i WHERE i.adjustment_id=OLD.id) THEN
    RAISE EXCEPTION 'make-good proposal is immutable; append a validated entitlement revision' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_makegood_adjustment BEFORE UPDATE OR DELETE ON public.ca_manual_adjustments
  FOR EACH ROW EXECUTE FUNCTION ca_makegood.protect_adjustment();

CREATE FUNCTION public.fn_ca_makegood_pay(p_item_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE i ca_makegood.items%ROWTYPE; d ca_makegood.debts%ROWTYPE; v ca_makegood.revisions%ROWTYPE;
  f ca_makegood.funding%ROWTYPE; fact jsonb; result jsonb; paid numeric; budget_paid numeric;
  member_before numeric; member_after numeric; bank_before numeric; bank_after numeric;
  leg uuid; wt uuid; n integer; setting_name text; saved jsonb:='{}';
BEGIN
  PERFORM ca_makegood.assert_server();
  SELECT * INTO i FROM ca_makegood.items WHERE id=p_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'make-good item missing' USING ERRCODE='P0002'; END IF;
  SELECT * INTO d FROM ca_makegood.debts WHERE id=i.debt_id;
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(d.tournament_id);
  PERFORM 1 FROM public.tournaments WHERE id=d.tournament_id FOR UPDATE;
  PERFORM 1 FROM ca_makegood.debts WHERE id=d.id FOR UPDATE;
  SELECT * INTO i FROM ca_makegood.items WHERE id=p_item_id FOR UPDATE;
  SELECT r.receipt INTO result FROM ca_makegood.receipts r WHERE r.item_id=i.id;
  IF FOUND THEN RETURN result; END IF;
  SELECT * INTO v FROM ca_makegood.revisions WHERE id=i.revision_id;
  IF EXISTS (SELECT 1 FROM ca_makegood.revisions newer WHERE newer.debt_id=d.id AND newer.revision>v.revision) THEN
    RAISE EXCEPTION 'stale entitlement revision; use a reviewed incremental item' USING ERRCODE='P0404'; END IF;
  fact:=ca_makegood.derive(v.recipe,v.source_id);
  IF fact->'evidence' IS DISTINCT FROM v.evidence OR fact->'ordinary_receipts' IS DISTINCT FROM v.ordinary_receipts
     OR (fact->>'total_entitlement')::numeric IS DISTINCT FROM v.total_entitlement
     OR (fact->>'ordinary_paid')::numeric IS DISTINCT FROM v.ordinary_paid THEN
    RAISE EXCEPTION 'financial evidence changed; refuse stale immutable item' USING ERRCODE='P0404'; END IF;
  SELECT coalesce(sum(r.amount),0) INTO paid FROM ca_makegood.receipts r WHERE r.debt_id=d.id;
  IF i.amount IS DISTINCT FROM greatest(0,v.total_entitlement-v.ordinary_paid-paid) THEN
    RAISE EXCEPTION 'item exceeds or differs from positive remaining entitlement' USING ERRCODE='P0404'; END IF;
  PERFORM 1 FROM public.ca_manual_adjustments a WHERE a.id=i.adjustment_id AND a.status='proposed'
    AND a.amount=i.amount AND a.asset='chips' AND a.target_kind='player_wallet' AND a.target_id=d.user_id AND a.tournament_id=d.tournament_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'recorded proposal is not eligible' USING ERRCODE='P0404'; END IF;
  SELECT * INTO f FROM ca_makegood.funding WHERE id=i.funding_id;
  -- Same account order and declaration contract as installed fn_club_bank_send:
  -- exact member wallet, then shared treasury. No identity impersonation.
  SELECT chip_balance INTO member_before FROM public.club_members
    WHERE club_id=d.wallet_club_id AND user_id=d.user_id AND coalesce(status,'active') IN ('active','approved')
      AND role<>'admin' FOR UPDATE;
  SELECT chip_treasury INTO bank_before FROM public.clubs WHERE id=f.club_id FOR UPDATE;
  SELECT coalesce(sum(r.amount),0) INTO budget_paid FROM ca_makegood.receipts r WHERE r.funding_id=f.id;
  IF member_before IS NULL OR bank_before IS NULL OR bank_before<i.amount OR f.amount-budget_paid<i.amount
     OR bank_before::text IN ('NaN','Infinity','-Infinity') OR member_before::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'insufficient verified shared house funding or recipient wallet unavailable' USING ERRCODE='P0404'; END IF;
  IF (SELECT to_jsonb(l) FROM public.chip_ledger l WHERE l.id=f.funding_ledger_id) IS DISTINCT FROM f.source_fact THEN
    RAISE EXCEPTION 'funding source receipt changed' USING ERRCODE='P0404'; END IF;
  IF public.fn_platform_frozen() OR EXISTS (SELECT 1 FROM public.ca_payout_freeze WHERE scope='tournament_payouts' AND cleared_at IS NULL) THEN
    RAISE EXCEPTION 'payouts are frozen' USING ERRCODE='55000'; END IF;
  FOREACH setting_name IN ARRAY ARRAY['app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_tournament','app.ledger_idempotency_key','app.ledger_autoskip_clubs','app.ledger_autoskip_club_members','app.ledger_correlation'] LOOP
    saved:=saved||jsonb_build_object(setting_name,current_setting(setting_name,true));
  END LOOP;
  wt:=gen_random_uuid();
  INSERT INTO ca_makegood.authorizations(item_id,transaction_id,backend_pid,wallet_transaction_id,bank_before,wallet_before,terminal_before)
    VALUES(i.id,pg_current_xact_id(),pg_backend_pid(),wt,bank_before,member_before,ca_makegood.terminal_state(d.tournament_id));
  PERFORM public.fn_ca_declare_ledger('adjustment','club_treasury',f.club_id,NULL,i.idempotency_key,ARRAY['clubs']);
  PERFORM set_config('app.ledger_autoskip_club_members','',true);
  PERFORM set_config('app.ledger_tournament',d.tournament_id::text,true);
  PERFORM set_config('app.ledger_correlation',i.id::text,true);
  INSERT INTO public.wallet_credit_idempotency(key,user_id,amount) VALUES(i.idempotency_key,d.user_id,i.amount);
  UPDATE public.clubs SET chip_treasury=chip_treasury-i.amount,updated_at=now()
    WHERE id=f.club_id AND chip_treasury>=i.amount RETURNING chip_treasury INTO bank_after;
  IF bank_after IS NULL THEN RAISE EXCEPTION 'atomic house debit refused' USING ERRCODE='P0404'; END IF;
  UPDATE public.club_members SET chip_balance=chip_balance+i.amount,updated_at=now()
    WHERE club_id=d.wallet_club_id AND user_id=d.user_id RETURNING chip_balance INTO member_after;
  SELECT count(*),min(id::text)::uuid INTO n,leg FROM public.chip_ledger
    WHERE idempotency_key=i.idempotency_key AND from_type='club_treasury' AND from_entity_id=f.club_id
      AND to_type='player_wallet' AND to_entity_id=d.user_id AND amount=i.amount AND club_id=d.wallet_club_id AND tournament_id=d.tournament_id;
  IF n<>1 OR member_after IS DISTINCT FROM member_before+i.amount OR bank_after IS DISTINCT FROM bank_before-i.amount THEN
    RAISE EXCEPTION 'balanced funded transfer receipt mismatch' USING ERRCODE='P0404'; END IF;
  INSERT INTO public.wallet_transactions(id,user_id,wallet_type,amount,type,category,description,related_entity_id,balance_after)
    VALUES(wt,d.user_id,'PLAYER',i.amount,'credit','settlement','Audited house make-good item '||i.id,d.tournament_id,member_after) RETURNING id INTO wt;
  FOREACH setting_name IN ARRAY ARRAY['app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_tournament','app.ledger_idempotency_key','app.ledger_autoskip_clubs','app.ledger_autoskip_club_members','app.ledger_correlation'] LOOP
    PERFORM set_config(setting_name,coalesce(saved->>setting_name,''),true);
  END LOOP;
  result:=jsonb_build_object('item_id',i.id,'adjustment_id',i.adjustment_id,'debt_id',d.id,'revision_id',v.id,'funding_id',f.id,
    'funding_ledger_id',f.funding_ledger_id,'ledger_id',leg,'wallet_transaction_id',wt,'idempotency_key',i.idempotency_key,
    'amount',i.amount,'total_entitlement',v.total_entitlement,'ordinary_paid',v.ordinary_paid,'makegood_paid',paid+i.amount,
    'source_identity',d.source_identity,'user_id',d.user_id,'wallet_club_id',d.wallet_club_id,'bank_before',bank_before,'bank_after',bank_after,
    'wallet_before',member_before,'wallet_after',member_after,'paid_at',clock_timestamp());
  INSERT INTO ca_makegood.receipts(item_id,debt_id,funding_id,ledger_id,wallet_transaction_id,amount,receipt)
    VALUES(i.id,d.id,f.id,leg,wt,i.amount,result);
  DELETE FROM ca_makegood.authorizations WHERE item_id=i.id;
  RETURN result;
END $$;

-- The existing idempotency insert is before every wallet move. Acquire the same
-- event row here for legacy direct credit calls too. The ordinary transaction
-- then either precedes the make-good (which refuses its stale item), or observes
-- the source disposition and cannot credit a second time. No obligation counter
-- is forged and no refund tranche is invented from house money.
CREATE FUNCTION ca_makegood.guard_ordinary_credit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE tid uuid; obligation uuid; k text; source text; covered jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public.wallet_credit_idempotency prior
      WHERE prior.key=NEW.key AND prior.user_id=NEW.user_id AND prior.amount=NEW.amount) THEN
    RETURN NEW; -- ON CONFLICT is a no-write replay; its original authority checks the receipt.
  END IF;
  IF NEW.key LIKE 'mb:%' THEN
    SELECT a.tournament_id,'mystery_bounty','award:'||a.id INTO tid,k,source
      FROM public.tournament_bounty_awards a WHERE a.id::text=split_part(NEW.key,':',2)
      AND NEW.user_id::text=split_part(NEW.key,':',3);
  ELSIF NEW.key LIKE 'tourney:%' THEN
    BEGIN tid:=split_part(NEW.key,':',2)::uuid; EXCEPTION WHEN invalid_text_representation THEN RETURN NEW; END;
  ELSE RETURN NEW; END IF;
  PERFORM 1 FROM public.tournaments WHERE id=tid FOR UPDATE;
  IF NEW.key LIKE 'mb:%' THEN NULL;
  ELSIF split_part(NEW.key,':',3)='obl' THEN
    BEGIN obligation:=split_part(NEW.key,':',4)::uuid; EXCEPTION WHEN invalid_text_representation THEN RETURN NEW; END;
    SELECT kind INTO k FROM public.tournament_obligations WHERE id=obligation AND tournament_id=tid AND user_id=NEW.user_id;
  ELSIF split_part(NEW.key,':',3)='refund-entitlement' THEN
    SELECT 'refund','charge:'||e.source_ledger_id INTO k,source FROM public.tournament_refund_entitlements e WHERE e.id::text=split_part(NEW.key,':',4);
  ELSE
    SELECT CASE WHEN s.source IN ('bounty','own_bounty') THEN 'bounty'
      WHEN s.source IN ('mystery_bounty','mystery_bounty_residual') THEN 'mystery_bounty'
      WHEN s.source IS NOT NULL THEN 'place' END INTO k FROM public.fn_tournament_payout_shape(NEW.key) s;
  END IF;
  IF k IN ('bounty','mystery_bounty') AND source IS NULL THEN
    SELECT c.source_identity INTO source FROM ca_makegood.ordinary_context c
      WHERE c.transaction_id=pg_current_xact_id() AND c.backend_pid=pg_backend_pid()
        AND c.tournament_id=tid AND c.user_id=NEW.user_id AND c.kind=k;
    IF source IS NULL THEN
      IF EXISTS (SELECT 1 FROM ca_makegood.debts d JOIN ca_makegood.receipts r ON r.debt_id=d.id
          WHERE d.tournament_id=tid AND d.user_id=NEW.user_id AND d.kind=k) THEN
        RAISE EXCEPTION 'unattributed aggregate bounty credit cannot resolve a source with house disposition' USING ERRCODE='P0404';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  SELECT jsonb_agg(r.receipt ORDER BY r.paid_at) INTO covered FROM ca_makegood.debts d JOIN ca_makegood.receipts r ON r.debt_id=d.id
    WHERE d.tournament_id=tid AND d.user_id=NEW.user_id AND d.kind=k AND (source IS NULL OR d.source_identity=source);
  IF covered IS NOT NULL THEN
    RAISE EXCEPTION 'ordinary payment debt has a house make-good disposition' USING ERRCODE='P0404',DETAIL=covered::text;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER makegood_debt_satisfaction BEFORE INSERT ON public.wallet_credit_idempotency
  FOR EACH ROW EXECUTE FUNCTION ca_makegood.guard_ordinary_credit();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ca_makegood FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_makegood_register_funding(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_makegood_propose(text,uuid,uuid,numeric,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_makegood_pay(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_makegood_register_funding(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_makegood_propose(text,uuid,uuid,numeric,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_makegood_pay(uuid) TO service_role;
-- The ordinary credit already owns the wallet key and payout evidence; pass
-- that same identity to the existing receiving-wallet journal trigger. Without
-- it a real normal payout produces an unkeyed leg and cannot be safely imported
-- into the all-path debt cap. No historical rows are rewritten.
DO $pin_credit_receipt$
DECLARE definition text; body text; before_text text; after_text text;
BEGIN
  SELECT pg_get_functiondef(oid),prosrc INTO definition,body FROM pg_proc
    WHERE oid='public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)'::regprocedure;
  IF md5(body)<>'facba80dff6edbe1b70a010f32bc5aad' THEN
    RAISE EXCEPTION 'ordinary credit dependency changed; re-review receipt composition';
  END IF;
  before_text := '  v_prev_cp_entity text;';
  after_text := before_text||E'\n  v_prev_makegood_ledger_key text;';
  IF (length(definition)-length(replace(definition,before_text,'')))/length(before_text)<>1 THEN RAISE EXCEPTION 'credit declaration anchor differs'; END IF;
  definition:=replace(definition,before_text,after_text);
  before_text := $anchor$  v_credited := public.fn_credit_player_wallet_once(
    p_user_id, p_amount, p_idempotency_key);$anchor$;
  after_text := $replacement$  v_prev_makegood_ledger_key := current_setting('app.ledger_idempotency_key',true);
  PERFORM set_config('app.ledger_idempotency_key',p_idempotency_key,true);
  v_credited := public.fn_credit_player_wallet_once(
    p_user_id, p_amount, p_idempotency_key);
  PERFORM set_config('app.ledger_idempotency_key',coalesce(v_prev_makegood_ledger_key,''),true);$replacement$;
  IF (length(definition)-length(replace(definition,before_text,'')))/length(before_text)<>1 THEN RAISE EXCEPTION 'credit invocation anchor differs'; END IF;
  EXECUTE replace(definition,before_text,after_text);
END $pin_credit_receipt$;
-- Pin and replace only the two calls that already own the exact source. This
-- adds provenance around the existing payment, without changing its amount,
-- eligibility, wallet, escrow or postconditions. Context is transaction-private.
DO $pin_bounty_sources$
DECLARE definition text; body text; old_call text; new_call text;
BEGIN
 SELECT pg_get_functiondef(oid),prosrc INTO definition,body FROM pg_proc
  WHERE oid='public.fn_collect_bounty(uuid,uuid,uuid,jsonb)'::regprocedure;
 IF md5(body)<>'313a8a2387f7cdcec3d84a961210ceff' THEN RAISE EXCEPTION 'KO payer dependency changed'; END IF;
 old_call:=$call$public.fn_settle_tournament_obligation(
          p_tournament_id, 'bounty', NULL, c.uid, round(v_prior + v_cash, 2),
          'fn_collect_bounty', v_desc)$call$;
 new_call:=$call$ca_makegood.settle_bounty_source(
          p_tournament_id, 'bounty', c.uid, round(v_prior + v_cash, 2),
          'fn_collect_bounty', v_desc, 'knockout:'||o.id)$call$;
 IF (length(definition)-length(replace(definition,old_call,'')))/length(old_call)<>1 THEN RAISE EXCEPTION 'KO source call anchor differs'; END IF;
 EXECUTE replace(definition,old_call,new_call);
 SELECT pg_get_functiondef(oid),prosrc INTO definition,body FROM pg_proc
  WHERE oid='public.fn_mystery_bounty_pay(uuid)'::regprocedure;
 IF md5(body)<>'8f16f673aeaafac711da36b0df9466a2' THEN RAISE EXCEPTION 'mystery payer dependency changed'; END IF;
 old_call:=$call$public.fn_settle_tournament_obligation(
      v_a.tournament_id, 'mystery_bounty', NULL, v_r.user_id,
      round(v_prior + (v_r.amount_cents / 100.0), 2),
      'fn_mystery_bounty_pay',
      'Mystery bounty revealed from eliminated player')$call$;
 new_call:=$call$ca_makegood.settle_bounty_source(
      v_a.tournament_id, 'mystery_bounty', v_r.user_id,
      round(v_prior + (v_r.amount_cents / 100.0), 2),
      'fn_mystery_bounty_pay',
      'Mystery bounty revealed from eliminated player','award:'||v_a.id)$call$;
 IF (length(definition)-length(replace(definition,old_call,'')))/length(old_call)<>1 THEN RAISE EXCEPTION 'mystery source call anchor differs'; END IF;
 EXECUTE replace(definition,old_call,new_call);
END $pin_bounty_sources$;

-- Preserve each installed guard body and its ACL. Only an INSERT carrying the
-- exact private, balanced, transaction-bound house item may add new evidence.
-- Existing tournament evidence, escrow and terminal receipts remain immutable.
DO $pin_terminal_guards$
DECLARE entry record; definition text; body text; insertion text;
BEGIN
 FOR entry IN SELECT * FROM (VALUES
   ('fn_terminal_tournament_evidence_is_immutable','e6fbb738a0528aa0f32e33d004bf2045',false),
   ('fn_cancelled_tournament_evidence_is_immutable','9dc93e1a464e6694f588345f19640869',false),
   ('fn_satellite_transfer_ledger_is_immutable','6f0c873ffaa7ed73f0936fb681da1a66',false),
   ('fn_terminal_wallet_transaction_is_immutable','f054ed37c1af938c38d3ae4df159ac5d',true),
   ('fn_cancelled_tournament_wallet_is_immutable','3be8b56169be207597cbf1e2c7f34d50',true)
 ) guards(name,expected,wallet) LOOP
   SELECT pg_get_functiondef(p.oid),p.prosrc INTO definition,body FROM pg_proc p
     WHERE p.oid=('public.'||entry.name||'()')::regprocedure;
   IF md5(body) IS DISTINCT FROM entry.expected THEN
     RAISE EXCEPTION 'terminal guard % changed; re-review exact make-good authorization',entry.name;
   END IF;
   IF (length(definition)-length(replace(definition,E'\nBEGIN\n','')))/length(E'\nBEGIN\n')<>1 THEN
     RAISE EXCEPTION 'terminal guard entry anchor differs'; END IF;
   insertion:=format($entry$
BEGIN
  IF TG_OP='INSERT' AND TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME=%L
     AND ca_makegood.exact_funded_leg(to_jsonb(NEW),%L) THEN RETURN NEW; END IF;
$entry$,
     CASE WHEN entry.wallet THEN 'wallet_transactions' ELSE 'chip_ledger' END,entry.wallet);
   EXECUTE replace(definition,E'\nBEGIN\n',insertion);
 END LOOP;
END $pin_terminal_guards$;
COMMIT;
