-- @live-proof: EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.poker_diamond_movements'::regclass AND conname='poker_diamond_movements_amount_check' AND NOT convalidated AND md5(pg_get_constraintdef(oid))='fc6c4f604342103c8181084586a69e44')
-- @live-proof: EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.poker_diamond_tournament_ledger'::regclass AND conname='poker_diamond_tournament_ledger_inflow' AND NOT convalidated AND md5(pg_get_constraintdef(oid))='14bb613840792e4fe07859f0e9ef8079')
-- Reserved by scripts/new-migration.mjs against the tree and remote branches.
-- Ticket escrow transfers move native custody, never a player's wallet.
-- Preserve all existing journal-backed, zero-close and house-transfer branches;
-- admit only explicitly described whole-Diamond ticket issue/admission legs.
-- Cross-row backing and one-time consumption remain the ordinary candidate's
-- immutable receipt and deferred custody guards, never a CHECK helper call.
-- @install-window: daily-maintenance
-- Writer-blocking CHECK replacement runs once in the certified daily freeze.
-- NOT VALID avoids scanning hot history; every new row is still checked.
-- The validated prior constraints prove old rows satisfy the retained branches.
-- Ordinary value-ticket helpers require these exact postimages before install.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
-- One short, ordered acquisition anchors both catalog preimages until commit.
LOCK TABLE public.poker_diamond_movements,public.poker_diamond_tournament_ledger IN ACCESS EXCLUSIVE MODE;

DO $ticket_constraint_preimage$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.poker_diamond_movements'::regclass
  AND conname='poker_diamond_movements_amount_check' AND contype='c' AND convalidated
  AND pg_get_constraintdef(oid)='CHECK ((((amount >= 1) AND (amount <= 2147483647) AND (wallet_journal_id IS NOT NULL)) OR ((action = ''release''::text) AND (amount = 0) AND (wallet_journal_id IS NULL)) OR ((amount >= 1) AND (amount <= 2147483647) AND (wallet_journal_id IS NULL) AND (((action = ''release''::text) AND (source_account ~~ ''arena_custody:%''::text) AND (destination_account = ''house''::text) AND ((request ->> ''action''::text) = ''tournament_drain''::text)) OR ((action = ''reserve''::text) AND (source_account ~~ ''house:%''::text) AND (destination_account ~~ ''arena_custody:%''::text) AND ((request ->> ''action''::text) = ANY (ARRAY[''spin_underwrite''::text, ''guarantee_overlay''::text])))))))') THEN
  RAISE EXCEPTION 'VALUE_TICKET_CONSTRAINT_PREIMAGE_CHANGED: poker_diamond_movements_amount_check';
 END IF;
END;
$ticket_constraint_preimage$;
ALTER TABLE public.poker_diamond_movements DROP CONSTRAINT poker_diamond_movements_amount_check;
ALTER TABLE public.poker_diamond_movements ADD CONSTRAINT poker_diamond_movements_amount_check
 CHECK (((((amount >= 1) AND (amount <= 2147483647) AND (wallet_journal_id IS NOT NULL)) OR ((action = 'release'::text) AND (amount = 0) AND (wallet_journal_id IS NULL)) OR ((amount >= 1) AND (amount <= 2147483647) AND (wallet_journal_id IS NULL) AND (((action = 'release'::text) AND (source_account ~~ 'arena_custody:%'::text) AND (destination_account = 'house'::text) AND ((request ->> 'action'::text) = 'tournament_drain'::text)) OR ((action = 'reserve'::text) AND (source_account ~~ 'house:%'::text) AND (destination_account ~~ 'arena_custody:%'::text) AND ((request ->> 'action'::text) = ANY (ARRAY['spin_underwrite'::text, 'guarantee_overlay'::text]))))))) OR ((amount BETWEEN 1 AND 2147483647 AND wallet_journal_id IS NULL
 AND request->>'ticket_contract'='same_value_entry_v1'
 AND request->>'ticket_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 AND (request->>'amount')::numeric=amount
 AND ((action='release'
   AND source_account='arena_custody:'||custody_id::text
   AND destination_account='ticket_escrow:'||(request->>'ticket_id')
   AND request->>'action'='tournament_drain' AND request->>'bank'='prize'
   AND request->>'delivery'='satellite_value_ticket'
   AND request->>'reason'='poker-value-ticket-issue:'||(request->>'ticket_id')
   AND request->>'payout_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
 OR (action='reserve'
   AND source_account='ticket_escrow:'||(request->>'ticket_id')
   AND destination_account='arena_custody:'||custody_id::text
   AND request->>'action'='satellite_value_ticket_entry'
   AND request->>'target_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND request->>'registration_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))) IS TRUE)) NOT VALID;

DO $ticket_constraint_preimage$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.poker_diamond_tournament_ledger'::regclass
  AND conname='poker_diamond_tournament_ledger_inflow' AND contype='c' AND convalidated
  AND pg_get_constraintdef(oid)='CHECK (((kind <> ALL (ARRAY[''entry''::text, ''rebuy''::text, ''reentry''::text, ''addon''::text])) OR ((user_id IS NOT NULL) AND (custody_id IS NOT NULL) AND (wallet_journal_id IS NOT NULL))))') THEN
  RAISE EXCEPTION 'VALUE_TICKET_CONSTRAINT_PREIMAGE_CHANGED: poker_diamond_tournament_ledger_inflow';
 END IF;
END;
$ticket_constraint_preimage$;
ALTER TABLE public.poker_diamond_tournament_ledger DROP CONSTRAINT poker_diamond_tournament_ledger_inflow;
ALTER TABLE public.poker_diamond_tournament_ledger ADD CONSTRAINT poker_diamond_tournament_ledger_inflow
 CHECK ((((kind <> ALL (ARRAY['entry'::text, 'rebuy'::text, 'reentry'::text, 'addon'::text])) OR ((user_id IS NOT NULL) AND (custody_id IS NOT NULL) AND (wallet_journal_id IS NOT NULL)))) OR ((kind='entry' AND user_id IS NOT NULL AND custody_id IS NOT NULL
 AND registration_id IS NOT NULL AND wallet_journal_id IS NULL
 AND request->>'source'='satellite_value_ticket'
 AND request->>'ticket_contract'='same_value_entry_v1'
 AND request->>'ticket_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 AND request->>'request_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 AND idempotency_key='poker-value-ticket-entry:'||(request->>'ticket_id')
 AND (request->>'gross')::numeric=amount
 AND (request->>'prize')::numeric=prize_part
 AND (request->>'bounty')::numeric=bounty_part
 AND (request->>'fee')::numeric=fee_part
 AND bounty_part=0 AND prize_part+fee_part=amount) IS TRUE)) NOT VALID;

COMMIT;
