-- 20261003220304_the_mint_register_keeps_its_supply_in_shards.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE MINT REGISTER KEEPS ITS SUPPLY IN SHARDS (phase 7 of 9: availability).
-- Full account:
-- docs/changelog/2026-10-03-the-mint-register-keeps-its-supply-in-shards.md.
--
-- Every chip retired from a hand or an event writes one register row through
-- fn_ca_register_issuance_leg (the deferred trigger
-- zz_ca_issuance_leg_is_registered on chip_ledger): 65,416 rows on
-- 2026-10-03. Each one computed supply_after by summing every chips row of
-- ca_mint_ledger. On 822,498 rows that sum is 0.67 s and 19,286 buffers with
-- two parallel workers (EXPLAIN ANALYZE, production, 2026-10-03 21:50), so
-- the register spent about 1,323 s of database time in the first 40 minutes
-- after the 21:00 restart, and the cost grows with every row it adds. It runs
-- inside the commit of the hand that raked.
--
-- The register now carries its signed total (mint +, anything else -, the
-- same rule the sum used) in ca_mint_supply_shards: 32 rows per asset, moved
-- by three statement-level triggers (trg_ca_mint_supply_shard_insert,
-- _update, _delete) from their transition tables: one upsert per asset per
-- statement. A transaction moves exactly one shard row per
-- asset (chosen from its transaction id), so concurrent commits rarely meet
-- and never wait on a single hot row. Reading the supply is a 32-row sum that
-- sees the same thing the old sum saw: every committed row plus this
-- transaction's own.
--
-- Seeded under a SHARE ROW EXCLUSIVE lock on ca_mint_ledger, so no row can
-- land between the seed and the trigger; the migration refuses to commit
-- unless the shards equal the register's own sum for every asset. Only the
-- supply read of fn_ca_register_issuance_leg changes; every other line is the
-- live text. No chips move. No job is added. No row of the register changes.
-- fn_ca_mint_supply_shards_agree() compares the shards with the full sum on
-- demand (read only, service role).
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_register_issuance_leg(uuid)'::regprocedure)) = 'ddf442eda21e107d2aa9f525e2c64f21')

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_register_issuance_leg(uuid)'::regprocedure)) IS DISTINCT FROM '8d3d5e1feccd96fcf0045afefdb9fcdc' THEN
    RAISE EXCEPTION 'SUPPLY_SHARDS_PREIMAGE_CHANGED';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_register_issuance_leg(uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'SUPPLY_SHARDS_AUTHORITY_CHANGED';
  END IF;
  IF to_regclass('public.ca_mint_supply_shards') IS NOT NULL THEN
    RAISE EXCEPTION 'SUPPLY_SHARDS_ALREADY_EXIST';
  END IF;
END
$pre$;

-- No register row may land between the seed and the trigger that keeps it.
LOCK TABLE public.ca_mint_ledger IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.ca_mint_supply_shards (
  asset text NOT NULL,
  shard smallint NOT NULL CHECK (shard BETWEEN 0 AND 31),
  net numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (asset, shard)
);
ALTER TABLE public.ca_mint_supply_shards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_mint_supply_shards FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ca_mint_supply_shards TO service_role;
COMMENT ON TABLE public.ca_mint_supply_shards IS
  'The signed total of ca_mint_ledger per asset (mint +, anything else -), kept in 32 shards so concurrent registers never meet on one row. Sum the shards of an asset for its supply. Maintained only by the triggers trg_ca_mint_supply_shard_insert, _update and _delete; checked by fn_ca_mint_supply_shards_agree().';

INSERT INTO public.ca_mint_supply_shards (asset, shard, net)
SELECT m.asset, 0, COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0)
  FROM public.ca_mint_ledger m
 GROUP BY m.asset;

CREATE FUNCTION public.fn_ca_mint_supply_shard_move()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  /* One shard per transaction: every statement of a transaction moves the
     same shard row of each asset it touches, so one transaction never holds
     two shards of one asset and two transactions meet only when their ids
     hash alike. One upsert per asset per statement, from the transition
     tables, so a statement that writes many register rows moves the shard
     once. */
  v_shard smallint := (((hashtext(txid_current()::text) % 32) + 32) % 32)::smallint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.ca_mint_supply_shards AS s (asset, shard, net)
    SELECT d.asset, v_shard, d.delta
      FROM (SELECT n.asset, SUM(CASE WHEN n.action = 'mint' THEN n.amount ELSE -n.amount END) AS delta
              FROM new_rows n GROUP BY n.asset) d
     WHERE d.delta <> 0
    ON CONFLICT (asset, shard) DO UPDATE SET net = s.net + EXCLUDED.net;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.ca_mint_supply_shards AS s (asset, shard, net)
    SELECT d.asset, v_shard, d.delta
      FROM (SELECT o.asset, -SUM(CASE WHEN o.action = 'mint' THEN o.amount ELSE -o.amount END) AS delta
              FROM old_rows o GROUP BY o.asset) d
     WHERE d.delta <> 0
    ON CONFLICT (asset, shard) DO UPDATE SET net = s.net + EXCLUDED.net;
  ELSE
    -- A link update (chip_ledger_id) nets to zero and moves nothing.
    INSERT INTO public.ca_mint_supply_shards AS s (asset, shard, net)
    SELECT d.asset, v_shard, d.delta
      FROM (SELECT x.asset, SUM(x.v) AS delta
              FROM (SELECT n.asset, CASE WHEN n.action = 'mint' THEN n.amount ELSE -n.amount END AS v FROM new_rows n
                    UNION ALL
                    SELECT o.asset, -(CASE WHEN o.action = 'mint' THEN o.amount ELSE -o.amount END) FROM old_rows o) x
             GROUP BY x.asset) d
     WHERE d.delta <> 0
    ON CONFLICT (asset, shard) DO UPDATE SET net = s.net + EXCLUDED.net;
  END IF;
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_mint_supply_shard_move() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_supply_shard_move() TO service_role;

CREATE TRIGGER trg_ca_mint_supply_shard_insert
  AFTER INSERT ON public.ca_mint_ledger
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_mint_supply_shard_move();
CREATE TRIGGER trg_ca_mint_supply_shard_update
  AFTER UPDATE ON public.ca_mint_ledger
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_mint_supply_shard_move();
CREATE TRIGGER trg_ca_mint_supply_shard_delete
  AFTER DELETE ON public.ca_mint_ledger
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_mint_supply_shard_move();

CREATE FUNCTION public.fn_ca_mint_supply_shards_agree()
 RETURNS TABLE(asset text, shards numeric, register numeric, agree boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH r AS (
    SELECT m.asset, COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0) AS total
      FROM public.ca_mint_ledger m GROUP BY m.asset
  ), s AS (
    SELECT x.asset, SUM(x.net) AS total FROM public.ca_mint_supply_shards x GROUP BY x.asset
  )
  SELECT COALESCE(r.asset, s.asset), COALESCE(s.total, 0), COALESCE(r.total, 0),
         COALESCE(s.total, 0) = COALESCE(r.total, 0)
    FROM r FULL JOIN s ON s.asset = r.asset;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_mint_supply_shards_agree() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_supply_shards_agree() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_register_issuance_leg(p_ledger_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  l record; v_action text; v_holder_type text; v_holder uuid; v_label text;
  v_before numeric; v_after numeric; v_supply numeric; v_reason text; v_op text;
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
BEGIN
  SELECT * INTO l FROM public.chip_ledger WHERE id = p_ledger_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_mint_ledger m WHERE m.chip_ledger_id = l.id) THEN
    RETURN false;
  END IF;
  IF l.category = 'correction' AND l.metadata->>'posted_via' = 'fn_ca_post_correction' THEN
    RETURN false;  -- a correction moves no balance (a_correction_is_not_a_mint)
  END IF;
  IF l.from_type = ANY (v_outside) AND NOT (l.to_type = ANY (v_outside)) THEN
    v_action := 'mint'; v_holder := l.to_entity_id;
    v_holder_type := CASE l.to_type
      WHEN 'club_treasury' THEN 'club' WHEN 'club_wallet' THEN 'club'
      WHEN 'union_bank' THEN 'union' WHEN 'union_wallet' THEN 'union'
      WHEN 'player_wallet' THEN 'player' WHEN 'promo_wallet' THEN 'player'
      ELSE 'circulation' END;
  ELSIF l.to_type = ANY (v_outside) AND NOT (l.from_type = ANY (v_outside)) THEN
    v_action := 'burn'; v_holder := l.from_entity_id;
    v_holder_type := CASE l.from_type
      WHEN 'club_treasury' THEN 'club' WHEN 'club_wallet' THEN 'club'
      WHEN 'union_bank' THEN 'union' WHEN 'union_wallet' THEN 'union'
      WHEN 'player_wallet' THEN 'player' WHEN 'promo_wallet' THEN 'player'
      ELSE 'circulation' END;
  ELSE
    RETURN false;  -- store to store, or circulating to circulating
  END IF;
  -- The autoledger stamps a union wallet's row with the union id; a union is
  -- also a row in clubs (is_union), so resolve by what the id actually is.
  IF v_holder_type = 'club' AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_holder AND COALESCE(c.is_union, false)) THEN
    v_holder_type := 'union';
  END IF;
  IF v_holder IS NULL THEN
    v_holder_type := 'circulation';
  END IF;
  IF v_holder_type = 'circulation' THEN
    v_holder := '00000000-0000-0000-0000-00000000c1c0';  -- the circulation sentinel (the house is ...d1a0)
  END IF;
  v_label := CASE v_holder_type
    WHEN 'club'   THEN (SELECT c.name FROM public.clubs c WHERE c.id = v_holder)
    WHEN 'union'  THEN COALESCE((SELECT u.name FROM public.unions u WHERE u.id = v_holder), (SELECT c.name FROM public.clubs c WHERE c.id = v_holder))
    WHEN 'player' THEN (SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text) FROM public.profiles p WHERE p.id = v_holder)
    ELSE 'circulation' END;
  -- A leg written by hand (a linked compensating entry) carries no balances;
  -- the register still wants a pair, so the pair is the amount itself.
  /* A door that wrote its own register row but did not link the leg
     (fn_ca_burn looks the leg up by a shape it does not always match):
     adopt that row rather than write a second one. Same action, holder,
     amount, asset, within five seconds of the leg, not yet linked. */
  UPDATE public.ca_mint_ledger m
     SET chip_ledger_id = l.id
   WHERE m.id = (SELECT m2.id FROM public.ca_mint_ledger m2
                  WHERE m2.chip_ledger_id IS NULL AND m2.asset = 'chips' AND m2.action = v_action
                    AND m2.amount = l.amount AND m2.holder_id = v_holder
                    AND m2.created_at BETWEEN l.created_at - interval '5 seconds' AND l.created_at + interval '5 seconds'
                  ORDER BY m2.created_at LIMIT 1);
  IF FOUND THEN RETURN false; END IF;
  v_before := COALESCE(CASE WHEN v_action = 'mint' THEN l.pre_to_balance ELSE l.pre_from_balance END, 0);
  v_after  := COALESCE(CASE WHEN v_action = 'mint' THEN l.post_to_balance ELSE l.post_from_balance END,
                       v_before + CASE WHEN v_action = 'mint' THEN l.amount ELSE -l.amount END);
  /* THE SUPPLY IS READ FROM ITS SHARDS (2026-10-03). This summed every chips
     row of the register for every leg it registered: 822,498 rows on
     2026-10-03, about 0.67 s and 19,286 buffers per call with two parallel
     workers, 65,000 calls a day, and growing with the register. The register
     now keeps the same signed total in ca_mint_supply_shards, moved by the
     statement triggers trg_ca_mint_supply_shard_* on every insert, change and
     delete of the register, so the same committed total plus this
     transaction's own rows is a read of at most 32 rows. */
  SELECT COALESCE(SUM(s.net), 0)
       + CASE WHEN v_action = 'mint' THEN l.amount ELSE -l.amount END
    INTO v_supply FROM public.ca_mint_supply_shards s WHERE s.asset = 'chips';
  v_op := 'ledger:' || l.id::text;
  v_reason := left(COALESCE(NULLIF(btrim(l.description), ''), l.category) || ' (' || l.category
              || CASE WHEN l.idempotency_key IS NOT NULL THEN ', key ' || l.idempotency_key ELSE '' END
              || '; registered from the journal leg)', 500);
  IF length(btrim(v_reason)) < 10 THEN v_reason := v_reason || ' - registered from the journal'; END IF;
  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason, performed_by, performed_by_label, db_role, chip_ledger_id, created_at)
  VALUES (v_op, v_action, 'chips', v_holder_type, v_holder, v_label, l.amount,
          v_before, v_after, v_supply, v_reason, l.performed_by, COALESCE(l.actor_service, l.db_role), l.db_role, l.id, l.created_at)
  ON CONFLICT (op_id) DO NOTHING;
  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_register_issuance_leg(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_register_issuance_leg(uuid) TO service_role;

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_register_issuance_leg(uuid)'::regprocedure)) IS DISTINCT FROM 'ddf442eda21e107d2aa9f525e2c64f21'
     OR (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_register_issuance_leg(uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'SUPPLY_SHARDS_RESULT_CHANGED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fn_ca_mint_supply_shards_agree() a WHERE NOT a.agree)
     OR NOT EXISTS (SELECT 1 FROM public.ca_mint_supply_shards WHERE asset = 'chips') THEN
    RAISE EXCEPTION 'SUPPLY_SHARDS_DO_NOT_AGREE_WITH_THE_REGISTER';
  END IF;
END
$post$;

COMMIT;
