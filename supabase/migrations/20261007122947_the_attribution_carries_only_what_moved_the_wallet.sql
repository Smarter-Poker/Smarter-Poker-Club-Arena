-- 20261007122947_the_attribution_carries_only_what_moved_the_wallet.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY. 20261007112751 taught fn_ca_mint_wallet_attribution
-- to carry a wallet's register chain forward over the journal rows the register
-- does not follow by design (origin NULL), because a buy-in after the last
-- register row moves the balance and was never meant to move the chain. Read
-- at 12:28 UTC, two minutes after 20261007112808 settled the cash rake rows,
-- register_drifts was 8: in all 8 wallets the only rows after the last register
-- instant that did not move the wallet were the 'cash_rake_correction' rows
-- the settlement had just written. Those rows are source 'journal_backfill'
-- (origin NULL, so the register does not follow them), and they move no
-- balance: carrying them put each chain end exactly their sum away from
-- holdings. A journal_backfill row writes down a movement that already
-- happened, or corrects one that never did; it is not wallet movement and is
-- not carried. Read against production before writing: with this clause,
-- 0 drifts (1,863 agree, 272 opening stock only).
--
-- Byte-identical to the 20261007112751 definition except the clause marked
-- CHANGED 20261007122947. Same signature, same columns, same grants.
--
-- @live-proof: (SELECT (public.fn_ca_mint_register_attribution()->>'register_drifts')::int = 0)
--
-- One transaction (production DDL policy rule 1). Never inside :50-:03 UTC.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_ca_mint_wallet_attribution(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(user_id uuid, held numeric, register_net numeric, unattributed_opening_stock numeric, register_chain_end numeric, journal_rows_since_last_register bigint, verdict text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH scope AS (
    SELECT p.id, COALESCE(p.diamonds, 0)::numeric AS held
      FROM public.profiles p
     WHERE p_user_id IS NULL OR p.id = p_user_id
  ),
  last_reg AS (
    SELECT m.holder_id, max(m.created_at) AS at
      FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.holder_type = 'player'
     GROUP BY m.holder_id
  ),
  net AS (
    SELECT m.holder_id,
           SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END) AS n
      FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.holder_type = 'player'
     GROUP BY m.holder_id
  ),
  pre AS (
    SELECT s.id, s.held, COALESCE(n.n, 0) AS register_net,
           (lr.holder_id IS NOT NULL) AS tracked, lr.at AS last_reg_at,
           -- CHANGED 20261007112751. The journal movement after the chain's
           -- last instant that the register does not follow BY DESIGN
           -- (fn_ca_diamond_journal_origin returns NULL: the arena doors,
           -- player-to-player transfers, journal backfills, the Mint's and the
           -- seed door's own rows). A buy-in after a wallet's last register
           -- row moved its balance and was never meant to move its chain.
           -- Computed only when the chain does not already end at holdings.
           CASE WHEN lr.holder_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger m
                                  WHERE m.asset = 'diamonds' AND m.holder_type = 'player'
                                    AND m.holder_id = s.id AND m.created_at = lr.at
                                    AND m.balance_after = s.held)
                THEN (SELECT COALESCE(SUM(t.amount), 0) FROM public.diamond_transactions t
                       WHERE t.user_id = s.id AND t.created_at > lr.at
                         -- CHANGED 20261007122947. A 'journal_backfill' row
                         -- writes down a movement that already happened (or,
                         -- for a correction, one that never moved the wallet);
                         -- it moved nothing now, so it carries nothing.
                         AND COALESCE(t.source, '') <> 'journal_backfill'
                         AND public.fn_ca_diamond_journal_origin(t.type, t.transaction_type, t.source,
                                                                 t.issuance_class, t.amount) IS NULL)
                ELSE 0 END AS carried
      FROM scope s
      LEFT JOIN last_reg lr ON lr.holder_id = s.id
      LEFT JOIN net n ON n.holder_id = s.id
  ),
  base AS (
    SELECT p.id, p.held, p.register_net, p.tracked, p.last_reg_at,
           -- The reading at the wallet's latest register instant that AGREES
           -- with holdings, if there is one. Several rows can share one
           -- created_at (one transaction claiming many rewards), so
           -- ORDER BY created_at DESC LIMIT 1 picks arbitrarily among them,
           -- and that is what made an earlier reading of this report 38 false
           -- drifts. Read the chain by value. CHANGED 20261007112751: the
           -- chain is carried forward over the unfollowed-by-design movement.
           (SELECT m.balance_after FROM public.ca_mint_ledger m
             WHERE m.asset = 'diamonds' AND m.holder_type = 'player' AND m.holder_id = p.id
               AND m.created_at = p.last_reg_at AND m.balance_after + p.carried = p.held LIMIT 1) AS agreeing_end
      FROM pre p
  )
  SELECT b.id,
         b.held,
         b.register_net,
         b.held - b.register_net,
         CASE WHEN NOT b.tracked THEN NULL
              ELSE COALESCE(b.agreeing_end,
                     (SELECT max(m.balance_after) FROM public.ca_mint_ledger m
                       WHERE m.asset = 'diamonds' AND m.holder_type = 'player'
                         AND m.holder_id = b.id AND m.created_at = b.last_reg_at)) END,
         -- Counted ONLY where it is diagnostic, which is a drifting wallet.
         -- Counting it for all 1,427 cost 5.1 of this read's 5.6 seconds and
         -- told nobody anything: a wallet whose chain already ends at its
         -- holdings has no unfollowed movement to find. NULL means not
         -- counted, not zero.
         CASE WHEN b.tracked AND b.agreeing_end IS NULL
              THEN (SELECT count(*) FROM public.diamond_transactions t
                     WHERE t.user_id = b.id AND t.created_at > b.last_reg_at) END,
         CASE WHEN NOT b.tracked THEN 'opening_stock_only'
              WHEN b.agreeing_end IS NOT NULL THEN 'register_agrees'
              ELSE 'register_drifts' END
    FROM base b;
$function$;

-- Operator telemetry: exactly the grants production already has.
REVOKE ALL ON FUNCTION public.fn_ca_mint_wallet_attribution(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_wallet_attribution(uuid) TO service_role;

COMMIT;
