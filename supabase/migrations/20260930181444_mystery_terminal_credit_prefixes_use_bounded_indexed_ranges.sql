-- The two historical mystery receipts scanned all 560,000 wallet credit keys
-- three times each. Locale-aware key equality remains on the existing primary
-- key; this second operator class admits exact bytewise prefix ranges, including
-- contradictory keys with the wrong recipient or any Unicode suffix.
-- Every original LIKE, amount, recipient and interval validation is retained.
-- UUID prefixes end in ASCII hex; incrementing their final byte is the exact
-- residual-prefix successor. Prefixes ending ':' use ';' as their successor.
-- Index creation is a separate five-second-bounded statement in this one
-- transaction. Busy writers or an over-budget build roll everything back.
BEGIN;
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='1s';
DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_mystery_bounty_completion_evidence(uuid,uuid)'::regprocedure)) IS DISTINCT FROM 'b2c512b9b4f981eb9a698dc052aa384d'
    OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='public.fn_ca_mystery_bounty_completion_evidence(uuid,uuid)'::regprocedure)
 THEN RAISE EXCEPTION 'mystery credit prefix predecessor changed'; END IF;
 IF to_regclass('public.wallet_credit_idempotency_key_pattern_idx') IS NOT NULL THEN
  RAISE EXCEPTION 'mystery credit prefix index name already exists';
 END IF;
END $guard$;
CREATE INDEX wallet_credit_idempotency_key_pattern_idx
 ON public.wallet_credit_idempotency USING btree (key text_pattern_ops);
CREATE OR REPLACE FUNCTION public.fn_ca_mystery_bounty_completion_evidence(p_tournament_id uuid, p_winner_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t record;
  v_inventory_cents bigint;
  v_completed_award_cents bigint;
  v_void_chest_cents bigint;
  v_legacy_award_cents bigint;
  v_legacy_residual_cents bigint;
  v_legacy_residual_amount numeric;
  v_legacy_credit_cents bigint;
  v_obligation_cents bigint;
  v_evidence_mode text;
BEGIN
  IF p_tournament_id IS NULL OR p_winner_user_id IS NULL THEN
    RAISE EXCEPTION 'mystery completion evidence requires tournament and winner ids'
      USING ERRCODE = '22004';
  END IF;

  SELECT t.id,t.is_mystery_bounty,t.mystery_bounty_stage,
         t.mystery_bounty_pool_cents
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF NOT FOUND
     OR COALESCE(v_t.is_mystery_bounty,false) IS NOT TRUE
     OR v_t.mystery_bounty_stage IS DISTINCT FROM 'complete'
     OR COALESCE(v_t.mystery_bounty_pool_cents,0) <= 0 THEN
    RAISE EXCEPTION 'tournament % has no complete funded mystery inventory',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_winner_user_id
  ) THEN
    RAISE EXCEPTION 'mystery completion winner % is not in tournament %',
      p_winner_user_id,p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(sum(c.amount_cents),0),
         COALESCE(sum(c.amount_cents) FILTER (WHERE c.status = 'void'),0)
    INTO v_inventory_cents,v_void_chest_cents
    FROM public.tournament_bounty_chests c
   WHERE c.tournament_id = p_tournament_id;
  SELECT COALESCE(sum(a.amount_cents) FILTER (
           WHERE a.status = 'completed'),0)
    INTO v_completed_award_cents
    FROM public.tournament_bounty_awards a
   WHERE a.tournament_id = p_tournament_id;

  IF v_inventory_cents IS DISTINCT FROM v_t.mystery_bounty_pool_cents
     OR v_completed_award_cents + v_void_chest_cents
          IS DISTINCT FROM v_t.mystery_bounty_pool_cents
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_chests c
        WHERE c.tournament_id = p_tournament_id
          AND (c.amount_cents <= 0 OR c.status NOT IN ('paid','void')
            OR (c.status = 'paid' AND (c.award_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM public.tournament_bounty_awards a
               WHERE a.id = c.award_id
                 AND a.tournament_id = p_tournament_id
                 AND a.chest_id = c.id
                 AND a.amount_cents = c.amount_cents
                 AND a.status = 'completed')))
            OR (c.status = 'void' AND c.award_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM public.tournament_bounty_awards a
               WHERE a.id = c.award_id
                 AND a.tournament_id = p_tournament_id
                 AND a.chest_id = c.id
                 AND a.amount_cents = c.amount_cents
                 AND a.status = 'void'))))
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_awards a
        JOIN public.tournament_bounty_chests c ON c.id = a.chest_id
       WHERE a.tournament_id = p_tournament_id
         AND (c.tournament_id IS DISTINCT FROM p_tournament_id
           OR c.award_id IS DISTINCT FROM a.id
           OR c.amount_cents IS DISTINCT FROM a.amount_cents
           OR a.status NOT IN ('completed','void')
           OR (a.status = 'completed' AND (
             c.status <> 'paid' OR a.paid_at IS NULL
             OR (SELECT count(*)
                   FROM public.tournament_bounty_award_recipients r
                  WHERE r.award_id = a.id AND r.amount_cents > 0) < 1
             OR (SELECT COALESCE(sum(r.amount_cents),0)
                   FROM public.tournament_bounty_award_recipients r
                  WHERE r.award_id = a.id) <> a.amount_cents
             OR EXISTS (
               SELECT 1 FROM public.tournament_bounty_award_recipients r
                WHERE r.award_id = a.id
                  AND (r.amount_cents <= 0 OR r.paid_at IS NULL))))
           OR (a.status = 'void' AND (
             c.status <> 'void' OR a.paid_at IS NOT NULL OR EXISTS (
               SELECT 1 FROM public.tournament_bounty_award_recipients r
                WHERE r.award_id = a.id AND r.paid_at IS NOT NULL)))))
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_chests c
        WHERE c.tournament_id = p_tournament_id
          AND c.status = 'paid'
          AND (SELECT count(*) FROM public.tournament_bounty_awards a
                WHERE a.id = c.award_id AND a.chest_id = c.id
                  AND a.tournament_id = p_tournament_id
                  AND a.status = 'completed') <> 1)
  THEN
    RAISE EXCEPTION 'tournament % has malformed or open mystery inventory',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Every legacy award key must name one exact completed recipient. A key with
  -- an award prefix but the wrong user or amount is contradictory evidence,
  -- not a reason to classify the recipient as obligation-era.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_bounty_awards a
      JOIN public.wallet_credit_idempotency k
        ON k.key ~>=~ ('mb:' || a.id::text || ':')
       AND k.key ~<~ ('mb:' || a.id::text || ';')
       AND k.key LIKE 'mb:' || a.id::text || ':%'
     WHERE a.tournament_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_award_recipients r
          WHERE r.award_id = a.id
            AND k.key = 'mb:' || a.id::text || ':' || r.user_id::text
            AND k.user_id = r.user_id
            AND k.amount IS NOT NULL
            AND k.amount::text NOT IN ('NaN','Infinity','-Infinity')
            AND k.amount = round(r.amount_cents / 100.0,2)))
     OR EXISTS (
       SELECT 1 FROM public.wallet_credit_idempotency k
        WHERE k.key ~>=~ ('mb-residual:' || p_tournament_id::text)
          AND k.key ~<~ ('mb-residual:' || left(p_tournament_id::text,35) || chr(ascii(right(p_tournament_id::text,1))+1))
          AND k.key LIKE 'mb-residual:' || p_tournament_id::text || '%'
          AND k.key <> 'mb-residual:' || p_tournament_id::text)
  THEN
    RAISE EXCEPTION 'tournament % has malformed legacy mystery credit keys',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(sum(r.amount_cents),0)
    INTO v_legacy_award_cents
    FROM public.tournament_bounty_awards a
    JOIN public.tournament_bounty_award_recipients r ON r.award_id = a.id
    JOIN public.wallet_credit_idempotency k
      ON k.key = 'mb:' || a.id::text || ':' || r.user_id::text
     AND k.user_id = r.user_id
     AND k.amount = round(r.amount_cents / 100.0,2)
   WHERE a.tournament_id = p_tournament_id
     AND a.status = 'completed' AND r.paid_at IS NOT NULL;

  SELECT k.amount
    INTO v_legacy_residual_amount
    FROM public.wallet_credit_idempotency k
   WHERE k.key = 'mb-residual:' || p_tournament_id::text;
  IF FOUND AND (
       v_legacy_residual_amount IS NULL
       OR v_legacy_residual_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_legacy_residual_amount <= 0
       OR v_legacy_residual_amount <> round(v_legacy_residual_amount,2)
  ) THEN
    RAISE EXCEPTION 'tournament % has a malformed legacy mystery residual',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_legacy_residual_cents := CASE
    WHEN v_legacy_residual_amount IS NULL THEN 0
    ELSE round(v_legacy_residual_amount * 100)::bigint END;
  IF v_legacy_residual_cents > 0 AND NOT EXISTS (
    SELECT 1 FROM public.wallet_credit_idempotency k
     WHERE k.key = 'mb-residual:' || p_tournament_id::text
       AND k.user_id = p_winner_user_id
       AND k.amount::text NOT IN ('NaN','Infinity','-Infinity')
       AND k.amount > 0 AND k.amount = round(k.amount,2)
       AND round(k.amount * 100)::bigint = v_void_chest_cents
  ) THEN
    RAISE EXCEPTION 'tournament % legacy mystery residual is not its exact void inventory',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_legacy_credit_cents := v_legacy_award_cents + v_legacy_residual_cents;

  -- Obligation credits use one immutable key per cumulative increment. The
  -- suffix is the prior paid cents. Ordered intervals must cover [0,paid)
  -- exactly, which proves no missing, overlapping or invented increment.
  IF EXISTS (
    SELECT 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'mystery_bounty'
       AND (o.place IS NOT NULL OR o.user_id IS NULL
         OR o.amount_owed IS NULL OR o.amount_paid IS NULL
         OR o.amount_owed::text IN ('NaN','Infinity','-Infinity')
         OR o.amount_paid::text IN ('NaN','Infinity','-Infinity')
         OR o.amount_paid <= 0 OR o.amount_paid <> round(o.amount_paid,2)
         OR o.amount_owed IS DISTINCT FROM o.amount_paid
         OR o.settled_at IS NULL))
     OR EXISTS (
       SELECT 1
         FROM public.tournament_obligations o
         JOIN public.wallet_credit_idempotency k
           ON k.key ~>=~ ('tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':')
                       AND k.key ~<~ ('tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ';')
                       AND k.key LIKE 'tourney:' || p_tournament_id::text ||
                         ':obl:' || o.id::text || ':%'
        WHERE o.tournament_id = p_tournament_id
          AND o.kind = 'mystery_bounty'
          AND (k.user_id IS DISTINCT FROM o.user_id
            OR k.amount IS NULL
            OR k.amount::text IN ('NaN','Infinity','-Infinity')
            OR k.amount <= 0 OR k.amount <> round(k.amount,2)
            OR split_part(k.key,':',5) !~ '^[0-9]+$'))
     OR EXISTS (
       WITH key_intervals AS (
         SELECT o.id,o.amount_paid,
                CASE WHEN split_part(k.key,':',5) ~ '^[0-9]+$'
                     THEN split_part(k.key,':',5)::bigint END
                  AS starts_at_cents,
                CASE WHEN k.amount IS NOT NULL
                           AND k.amount::text NOT IN
                               ('NaN','Infinity','-Infinity')
                           AND k.amount > 0 AND k.amount = round(k.amount,2)
                     THEN round(k.amount * 100)::bigint END
                  AS paid_cents
           FROM public.tournament_obligations o
           JOIN public.wallet_credit_idempotency k
             ON k.key ~>=~ ('tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':')
                         AND k.key ~<~ ('tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ';')
                         AND k.key LIKE 'tourney:' || p_tournament_id::text ||
                           ':obl:' || o.id::text || ':%'
          WHERE o.tournament_id = p_tournament_id
            AND o.kind = 'mystery_bounty'
       ), exact_intervals AS (
         SELECT i.*,
                COALESCE(sum(i.paid_cents) OVER (
                  PARTITION BY i.id ORDER BY i.starts_at_cents
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)
                  AS expected_start_cents,
                sum(i.paid_cents) OVER (PARTITION BY i.id) AS total_key_cents
           FROM key_intervals i
       )
       SELECT 1
         FROM public.tournament_obligations o
         LEFT JOIN exact_intervals i ON i.id = o.id
        WHERE o.tournament_id = p_tournament_id
          AND o.kind = 'mystery_bounty'
        GROUP BY o.id,o.amount_paid
       HAVING count(i.id) = 0
           OR bool_or(i.starts_at_cents <> i.expected_start_cents)
           OR max(i.total_key_cents) <>
                round(o.amount_paid * 100)::bigint)
  THEN
    RAISE EXCEPTION 'tournament % has incomplete mystery obligation credit keys',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(o.amount_paid),0) * 100)::bigint
    INTO v_obligation_cents
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'mystery_bounty';

  -- Allocate every uncovered paid recipient to that recipient's obligation,
  -- and every uncovered void chest to the champion's obligation. This is an
  -- exact per-user partition, stronger than a pool-only total.
  IF EXISTS (
    WITH uncovered AS (
      SELECT r.user_id,sum(r.amount_cents)::bigint AS cents
        FROM public.tournament_bounty_awards a
        JOIN public.tournament_bounty_award_recipients r ON r.award_id = a.id
        LEFT JOIN public.wallet_credit_idempotency k
          ON k.key = 'mb:' || a.id::text || ':' || r.user_id::text
         AND k.user_id = r.user_id
         AND k.amount = round(r.amount_cents / 100.0,2)
       WHERE a.tournament_id = p_tournament_id
         AND a.status = 'completed' AND r.paid_at IS NOT NULL
         AND k.key IS NULL
       GROUP BY r.user_id
      UNION ALL
      SELECT p_winner_user_id,v_void_chest_cents
       WHERE v_void_chest_cents > 0
         AND v_legacy_residual_cents = 0
    ), expected AS (
      SELECT u.user_id,sum(u.cents)::bigint AS cents
        FROM uncovered u GROUP BY u.user_id
    ), obligated AS (
      SELECT o.user_id,round(sum(o.amount_paid) * 100)::bigint AS cents
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'mystery_bounty'
       GROUP BY o.user_id
    )
    SELECT 1 FROM expected e
    FULL JOIN obligated o USING (user_id)
     WHERE COALESCE(e.cents,0) IS DISTINCT FROM COALESCE(o.cents,0)
  ) OR v_legacy_credit_cents + v_obligation_cents
         IS DISTINCT FROM v_t.mystery_bounty_pool_cents THEN
    RAISE EXCEPTION
      'tournament % mystery credit eras do not exactly cover its pool (% legacy + % obligation <> %)',
      p_tournament_id,v_legacy_credit_cents,v_obligation_cents,
      v_t.mystery_bounty_pool_cents USING ERRCODE = 'P0404';
  END IF;

  v_evidence_mode := CASE
    WHEN v_legacy_credit_cents > 0 AND v_obligation_cents > 0 THEN 'mixed'
    WHEN v_legacy_credit_cents > 0 THEN 'legacy_wallet_keys'
    ELSE 'obligations'
  END;
  RETURN jsonb_build_object(
    'evidence_version',1,
    'evidence_mode',v_evidence_mode,
    'pool_cents',v_t.mystery_bounty_pool_cents,
    'inventory_cents',v_inventory_cents,
    'completed_award_cents',v_completed_award_cents,
    'void_chest_cents',v_void_chest_cents,
    'legacy_award_credit_cents',v_legacy_award_cents,
    'legacy_residual_credit_cents',v_legacy_residual_cents,
    'legacy_credit_cents',v_legacy_credit_cents,
    'obligation_cents',v_obligation_cents);
END;
$function$
;
COMMIT;
