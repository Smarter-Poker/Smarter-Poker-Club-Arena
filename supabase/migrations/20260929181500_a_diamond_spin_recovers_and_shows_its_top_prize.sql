-- ============================================================================
-- A DIAMOND SPIN RECOVERS AND SHOWS ITS TOP PRIZE
-- ============================================================================
--
-- Phase 9 of the Diamond Arena programme: the two gaps the Diamond Spin left
-- open (20260929163000_a_diamond_spin_draws_a_whole_prize, "What Is Still Not
-- Here"). This is the Spin tournament format, not the Diamond Spins bonus
-- wheel, which nothing here touches.
--
-- 1. A PLAYED DIAMOND SPIN RECOVERS AS A PLAYED CHIP SPIN DOES.
--    A Spin whose launch was interrupted after it dealt (its draw committed, a
--    hand persisted, one player busted and vacated, its launch receipt still
--    incomplete) is finished through one narrow proof,
--    fn_prove_played_spin_launch_recovery: the manager reads it before it
--    lowers the field to the two survivors, the one draw authority reads it
--    before it replays the committed draw, and the launch completion reads it
--    again under the tournament lock. The proof read chip records only (the
--    refund entitlements, the wallet debits, their chip ledger legs, the
--    owner's reserve draw and the chip escrow), so a Diamond Spin in that
--    state answered played_spin_launch_recovery_unproven and stayed parked,
--    its entries in custody with nothing to release them.
--
--    The proof now routes a Diamond Spin to its Diamond arm,
--    fn_poker_diamond_prove_played_spin_launch_recovery, which proves the same
--    facts from the records a Diamond Spin keeps: the three entry rows of the
--    Diamond tournament ledger (a chip Spin's entitlements), the players' own
--    reserve movements into the event's custody (its wallet debits), each
--    entry's active custody, registration, movement and wallet journal (its
--    source ledger legs), the one committed Diamond draw read back by
--    fn_poker_diamond_spin_draw_proof against the row, the legs and the
--    source's register rows (its reserve contribution, draw, pool and
--    journals), and the Diamond banks and custody holding exactly the drawn
--    pool (its escrow). The field, the felt, the vacated seat and the hand are
--    proved by the chip rule's own text, copied verbatim, and the answer has
--    the chip answer's shape, so the manager's reader and both database
--    callers take it unchanged.
--
--    The Diamond arm of the draw authority, fn_poker_diamond_spin_draw, read
--    its field as registered or playing only, so a played Spin was refused
--    (spin_field_unproven) before it could replay its committed draw. It now
--    reads the field as the chip authority does: two players and a proven
--    played recovery read the original three, the bust included, and the
--    committed receipt replays. Nothing moves twice.
--
-- 2. A DIAMOND SPIN'S LOBBY CARD SHOWS ITS OWN TOP MULTIPLIER.
--    A filling Spin advertises "Win Up To" the top of its table. A Diamond Spin
--    draws from the table its creation pinned (poker_diamond_spin_contracts,
--    which no browser may read), and that table may top out elsewhere than the
--    chip ladder. fn_poker_diamond_spin_ceilings answers the lobby, for each
--    Diamond Spin id it is given, that table's top multiplier (the arithmetic
--    the creation door answers max_multiplier with) and nothing for any other
--    id. Signed-in players only; it reads and moves nothing.
--
-- The chip proof changes by one asserted substitution (live md5 pinned, the
-- clause occurs once, the reverse substitution proved): for a chip tournament
-- it answers exactly what it answered before. The Diamond draw arm is pinned
-- and redefined in full with the same signature. tournaments_enabled stays
-- false, no reserve source is authorized, nothing is priced.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_prove_played_spin_launch_recovery   8bc978cc105c18b2e3350016b48a50eb
--   fn_poker_diamond_spin_draw             b6bc15048a340464e845ee3f880cc325
-- ============================================================================

DO $m$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'tournaments_enabled is already on somewhere; this migration expects it closed';
  END IF;
  IF to_regprocedure('public.fn_poker_diamond_prove_played_spin_launch_recovery(uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_poker_diamond_spin_ceilings(uuid[])') IS NOT NULL THEN
    RAISE EXCEPTION 'the Diamond played-Spin proof or the lobby read already exists; this migration creates them';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 1. THE NEW DOORS ARE DECLARED BEFORE THEY EXIST
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_poker_diamond_prove_played_spin_launch_recovery', 'system',
   'Diamond Phase 9. The Diamond arm of fn_prove_played_spin_launch_recovery: proves a played Diamond Spin (one busted and vacated seat, a persisted hand, its launch incomplete) from its entry rows, custody, reserve movements and wallet journals, its committed draw and its banks, and the field, the felt and the hand by the chip rule''s own text. Reads only; owner-only. Moves no money.'),
  ('fn_poker_diamond_spin_ceilings', 'system',
   'Diamond Phase 9. The lobby read: for each Diamond Spin id, the top multiplier of the table its creation pinned (poker_diamond_spin_contracts), which its card advertises before the draw; nothing for any other id. Reads only; signed-in players. Moves no money.')
ON CONFLICT (proname) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. THE DIAMOND ARM OF THE PLAYED-SPIN PROOF
-- ---------------------------------------------------------------------------
-- Every CTE that proves the field, the felt, the vacated seat and the hand is
-- the chip proof's own text; the verdict is the chip verdict with its money
-- lines read from the Diamond records; the answer is the chip answer.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_prove_played_spin_launch_recovery(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
 SET statement_timeout TO '10s'
AS $function$
-- The Diamond arm of fn_prove_played_spin_launch_recovery (Diamond Phase 9).
-- The chip rule, word for word, for the field, the felt, the vacated seat and
-- the hand; the money evidence read from the records a Diamond Spin keeps.
WITH contract AS (
  SELECT t.id,
         t.status::text AS status,
         lower(COALESCE(t.variant, '')) AS variant,
         upper(COALESCE(t.tournament_type, '')) AS tournament_type,
         t.max_players,
         t.buy_in_amount AS buy_in,
         t.starting_chips
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
     AND public.fn_poker_diamond_tournament(t.id)
), roster AS (
  SELECT count(*) AS roster_count,
         count(DISTINCT tp.user_id) AS roster_users,
         count(*) FILTER (WHERE tp.status = 'playing') AS active_players,
         count(*) FILTER (WHERE tp.status = 'playing' AND tp.chips > 0)
           AS positive_active_players,
         count(*) FILTER (WHERE tp.status = 'eliminated') AS eliminated_players,
         count(*) FILTER (WHERE tp.status NOT IN ('playing', 'eliminated')) AS other_players,
         count(*) FILTER (WHERE tp.chips IS NULL OR tp.chips < 0) AS invalid_stacks,
         count(*) FILTER (WHERE tp.status = 'eliminated' AND tp.chips = 0)
           AS zero_stack_eliminations,
         COALESCE(sum(tp.chips), 0) AS roster_chips,
         COALESCE(
           array_agg(tp.user_id ORDER BY tp.user_id)
             FILTER (WHERE tp.user_id IS NOT NULL),
           ARRAY[]::uuid[]
         ) AS original_player_ids,
         COALESCE(
           array_agg(tp.user_id ORDER BY tp.user_id)
             FILTER (WHERE tp.status = 'playing'),
           ARRAY[]::uuid[]
         ) AS active_player_ids
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
), entitlements AS (
  -- A Diamond entry's immutable record is its entry row in the Diamond
  -- tournament ledger, where a chip entry's is its refund entitlement.
  SELECT count(l.id) AS entitlement_count,
         count(DISTINCT l.user_id) AS entitlement_users,
         count(DISTINCT l.user_id) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.user_id = l.user_id
           )
         ) AS roster_entitlement_users,
         min(l.amount) AS min_gross,
         max(l.amount) AS max_gross,
         round(COALESCE(sum(l.amount), 0), 2) AS gross_total
    FROM public.poker_diamond_tournament_ledger l
   WHERE l.tournament_id = p_tournament_id
     AND l.kind = 'entry'
), payments AS (
  -- A Diamond entry is paid by the player's own reserve movement from the
  -- wallet into the event's custody, where a chip entry is paid by its wallet
  -- debit. Every entry custody the event ever held is read, released or not.
  SELECT count(m.request_id) AS payment_count,
         count(DISTINCT m.user_id) AS paid_users,
         count(DISTINCT m.user_id) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.user_id = m.user_id
           )
         ) AS roster_paid_users,
         min(m.amount) AS min_amount,
         max(m.amount) AS max_amount,
         round(COALESCE(sum(m.amount), 0), 2) AS payment_total
    FROM public.poker_diamond_custody c
    JOIN public.poker_diamond_movements m
      ON m.custody_id = c.id
     AND m.action = 'reserve'
     AND m.source_account = 'player:' || m.user_id::text
   WHERE c.purpose = 'tournament_entry'
     AND c.target_id = p_tournament_id
), charge_evidence AS (
  -- Each entry row names its player's own active entry custody for this
  -- event, keyed to its registration, and the reserve movement and wallet
  -- journal that paid it in, where a chip entitlement names its source
  -- ledger leg.
  SELECT count(l.id) AS source_charge_count,
         count(l.id) FILTER (
           WHERE c.user_id = l.user_id
             AND c.purpose = 'tournament_entry'
             AND c.target_id = l.tournament_id
             AND c.state = 'active'
             AND c.entry_key = 'entry:' || l.registration_id::text
             AND l.prize_part = l.amount
             AND l.bounty_part = 0
             AND l.fee_part = 0
             AND EXISTS (
               SELECT 1
                 FROM public.tournament_players tp
                WHERE tp.id = l.registration_id
                  AND tp.tournament_id = l.tournament_id
                  AND tp.user_id = l.user_id
             )
             AND EXISTS (
               SELECT 1
                 FROM public.poker_diamond_movements m
                WHERE m.custody_id = c.id
                  AND m.action = 'reserve'
                  AND m.user_id = l.user_id
                  AND m.source_account = 'player:' || l.user_id::text
                  AND m.amount = l.amount
                  AND m.wallet_journal_id = l.wallet_journal_id
             )
             AND EXISTS (
               SELECT 1
                 FROM public.diamond_transactions j
                WHERE j.id = l.wallet_journal_id
                  AND j.user_id = l.user_id
                  AND j.amount = -l.amount
             )
         ) AS exact_source_charges
    FROM public.poker_diamond_tournament_ledger l
    LEFT JOIN public.poker_diamond_custody c ON c.id = l.custody_id
   WHERE l.tournament_id = p_tournament_id
     AND l.kind = 'entry'
), draw_evidence AS (
  -- The one committed Diamond draw, where a chip Spin has its reserve
  -- contribution and its jackpot draw.
  SELECT count(r.tournament_id) AS draw_count,
         min(r.created_at) AS draw_created_at,
         min(CASE WHEN jsonb_typeof(r.entrants) = 'array'
                  THEN jsonb_array_length(r.entrants) END) AS draw_seats,
         min(CASE WHEN jsonb_typeof(r.receipt->'buy_in') = 'number'
                  THEN (r.receipt->>'buy_in')::numeric END) AS draw_buy_in,
         min(CASE WHEN jsonb_typeof(r.receipt->'multiplier') = 'number'
                  THEN (r.receipt->>'multiplier')::numeric END) AS draw_multiplier,
         min(CASE WHEN jsonb_typeof(r.receipt->'prize_pool') = 'number'
                  THEN (r.receipt->>'prize_pool')::numeric END) AS draw_pool
    FROM public.spin_draw_receipts r
   WHERE r.tournament_id = p_tournament_id
), draw_proof AS (
  -- The draw read back against the tournament row, its ledger legs and the
  -- source's register rows, where a chip Spin has its pool and journals.
  SELECT COALESCE(
           (public.fn_poker_diamond_spin_draw_proof(p_tournament_id, NULL)->>'ok')::boolean,
           false
         ) AS draw_proven
), table_evidence AS (
  SELECT count(t.id) AS table_count,
         count(t.id) FILTER (WHERE t.status IN ('running', 'waiting')) AS open_tables,
         (array_agg(t.id ORDER BY t.created_at, t.id)
           FILTER (WHERE t.status IN ('running', 'waiting')))[1] AS table_id,
         min(t.current_players) FILTER (WHERE t.status IN ('running', 'waiting'))
           AS current_players,
         min(t.max_players) FILTER (WHERE t.status IN ('running', 'waiting'))
           AS table_capacity
    FROM public.tables t
   WHERE t.tournament_id = p_tournament_id
), live_seats AS (
  SELECT count(s.id) AS live_seats,
         count(DISTINCT s.user_id) AS live_users,
         count(DISTINCT (s.table_id, s.seat_number)) AS live_coordinates,
         count(DISTINCT s.table_id) AS live_tables,
         count(s.id) FILTER (
           WHERE s.stack IS NULL
              OR s.stack::text IN ('NaN', 'Infinity', '-Infinity')
              OR s.stack < 0
         ) AS invalid_live_stacks,
         count(s.id) FILTER (WHERE s.stack > 0) AS positive_live_seats,
         count(s.id) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.user_id = s.user_id
                AND tp.status = 'playing'
                AND tp.table_id = s.table_id
                AND tp.seat_number = s.seat_number
                AND tp.chips IS NOT DISTINCT FROM s.stack
           )
         ) AS matching_active_seats,
         COALESCE(sum(s.stack), 0) AS seat_chips
    FROM public.table_seats s
    JOIN public.tables t ON t.id = s.table_id
   WHERE t.tournament_id = p_tournament_id
     AND s.left_at IS NULL
), vacated_seat AS (
  SELECT count(DISTINCT tp.user_id) AS vacated_eliminated_players
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status = 'eliminated'
     AND EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables t ON t.id = s.table_id
        WHERE t.tournament_id = p_tournament_id
          AND s.user_id = tp.user_id
          AND s.left_at IS NOT NULL
     )
), hands AS (
  SELECT count(h.id) FILTER (WHERE h.created_at >= r.draw_created_at) AS hand_count
    FROM draw_evidence r
    LEFT JOIN public.hand_history h
      ON h.tournament_id = p_tournament_id
    LEFT JOIN public.tables t
      ON t.id = h.table_id
     AND t.tournament_id = p_tournament_id
   WHERE h.id IS NULL OR t.id IS NOT NULL
), escrow AS (
  -- The Diamond banks and the custody behind them hold exactly the drawn
  -- pool, where a chip Spin's escrow holds it.
  SELECT e.prize_balance,
         e.bounty_balance,
         e.fee_balance,
         public.fn_poker_diamond_tournament_custody(p_tournament_id) AS custody_total
    FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e
), facts AS (
  SELECT c.*,
         r.*,
         e.*,
         pay.*,
         charge.*,
         d.*,
         dp.*,
         te.*,
         ls.*,
         vs.*,
         h.*,
         esc.*,
         (c.starting_chips * 3)::numeric AS funding_floor
    FROM (SELECT 1) seed
    LEFT JOIN contract c ON true
    CROSS JOIN roster r
    CROSS JOIN entitlements e
    CROSS JOIN payments pay
    CROSS JOIN charge_evidence charge
    CROSS JOIN draw_evidence d
    CROSS JOIN draw_proof dp
    CROSS JOIN table_evidence te
    CROSS JOIN live_seats ls
    CROSS JOIN vacated_seat vs
    CROSS JOIN hands h
    CROSS JOIN escrow esc
), verdict AS (
  SELECT f.*,
         (f.id IS NOT NULL
          AND f.status = 'REGISTERING'
          AND (f.variant = 'spin' OR f.tournament_type = 'SPIN')
          AND f.variant <> 'sng'
          AND f.tournament_type <> 'SNG'
          AND f.max_players = 3
          AND f.buy_in IS NOT NULL
          AND f.buy_in::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND f.buy_in > 0
          AND f.starting_chips IS NOT NULL
          AND f.starting_chips > 0
          AND f.roster_count = 3
          AND f.roster_users = 3
          AND f.active_players = 2
          AND f.positive_active_players = 2
          AND f.eliminated_players = 1
          AND f.other_players = 0
          AND f.invalid_stacks = 0
          AND f.zero_stack_eliminations = 1
          AND f.roster_chips = f.funding_floor
          AND f.entitlement_count = 3
          AND f.entitlement_users = 3
          AND f.roster_entitlement_users = 3
          AND f.min_gross = f.buy_in
          AND f.max_gross = f.buy_in
          AND f.gross_total = round(f.buy_in * 3, 2)
          AND f.payment_count = 3
          AND f.paid_users = 3
          AND f.roster_paid_users = 3
          AND f.min_amount = f.buy_in
          AND f.max_amount = f.buy_in
          AND f.payment_total = round(f.buy_in * 3, 2)
          AND f.source_charge_count = 3
          AND f.exact_source_charges = 3
          AND f.draw_count = 1
          AND f.draw_proven
          AND f.draw_pool IS NOT NULL
          AND f.draw_pool = round(f.buy_in * f.draw_multiplier, 2)
          AND f.draw_buy_in = f.buy_in
          AND f.draw_seats = 3
          AND f.draw_multiplier > 0
          AND f.custody_total = f.draw_pool
          AND f.bounty_balance = 0
          AND f.fee_balance = 0
          AND f.prize_balance = f.draw_pool
          AND f.table_count = 1
          AND f.open_tables = 1
          AND f.current_players = 2
          AND f.table_capacity = 3
          AND f.live_seats = 2
          AND f.live_users = 2
          AND f.live_coordinates = 2
          AND f.live_tables = 1
          AND f.invalid_live_stacks = 0
          AND f.positive_live_seats = 2
          AND f.matching_active_seats = 2
          AND f.seat_chips = f.funding_floor
          AND f.seat_chips = f.roster_chips
          AND f.vacated_eliminated_players = 1
          AND f.hand_count >= 1) AS ok
    FROM facts f
)
SELECT CASE WHEN v.ok THEN
  jsonb_build_object(
    'ok', true,
    'recovery_mode', 'played_vacated_spin',
    'tournament_id', p_tournament_id,
    'original_field', 3,
    'active_field', 2,
    'eliminated_players', v.eliminated_players,
    'paid_users', v.paid_users,
    'entitlement_users', v.entitlement_users,
    'live_seats', v.live_seats,
    'hand_count', v.hand_count,
    'funding_floor', v.funding_floor,
    'roster_chips', v.roster_chips,
    'seat_chips', v.seat_chips,
    'original_player_ids', to_jsonb(v.original_player_ids),
    'active_player_ids', to_jsonb(v.active_player_ids)
  )
ELSE
  jsonb_build_object(
    'ok', false,
    'reason', 'played_spin_launch_recovery_unproven',
    'tournament_id', p_tournament_id
  )
END
  FROM verdict v;
$function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_prove_played_spin_launch_recovery(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. THE PLAYED-SPIN PROOF ROUTES A DIAMOND SPIN TO ITS ARM
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid; v_def text; v_n integer; v_old text; v_new text;
BEGIN
  v_oid := 'public.fn_prove_played_spin_launch_recovery(uuid)'::regprocedure;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '8bc978cc105c18b2e3350016b48a50eb' THEN
    RAISE EXCEPTION 'fn_prove_played_spin_launch_recovery is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'SELECT CASE WHEN v.ok THEN\n';
  v_new := E'SELECT CASE WHEN public.fn_poker_diamond_tournament(p_tournament_id) THEN\n  -- DIAMOND PHASE 9: a Diamond Spin is proved by its Diamond arm, which\n  -- reads its entries in custody, its draw and its banks where this reads\n  -- the chip entitlements, wallet debits, reserve draw and escrow; the\n  -- field, the felt, the vacated seat and the hand by these same rules.\n  public.fn_poker_diamond_prove_played_spin_launch_recovery(p_tournament_id)\nWHEN v.ok THEN\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_prove_played_spin_launch_recovery: the answer occurs % times, expected 1', v_n;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '8bc978cc105c18b2e3350016b48a50eb' THEN
    RAISE EXCEPTION 'fn_prove_played_spin_launch_recovery: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 4. THE DIAMOND DRAW ARM READS ITS FIELD AS THE CHIP AUTHORITY DOES
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_poker_diamond_spin_draw(uuid,uuid,uuid)'::regprocedure)) INTO v_md5;
  IF v_md5 <> 'b6bc15048a340464e845ee3f880cc325' THEN
    RAISE EXCEPTION 'fn_poker_diamond_spin_draw is not the pinned text (md5 %)', v_md5;
  END IF;
END $m$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_spin_draw(p_tournament_id uuid, p_launch_id uuid, p_lease_generation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_t public.tournaments%ROWTYPE;
  v_k public.poker_diamond_spin_contracts%ROWTYPE;
  v_source public.poker_diamond_spin_reserve_source%ROWTYPE;
  v_saved public.spin_draw_receipts%ROWTYPE;
  v_c public.poker_diamond_custody%ROWTYPE;
  v_p record; v_e record; v_x record; v_d jsonb; v_tier jsonb;
  v_entrants jsonb; v_count bigint; v_distinct bigint; v_rows_held bigint;
  v_b bigint; v_collected bigint; v_worst bigint; v_cover bigint;
  v_total numeric := 0; v_roll numeric; v_acc numeric := 0; v_pick numeric; v_tiers integer;
  v_cents numeric; v_prize bigint; v_residue numeric; v_underwrite bigint := 0; v_surplus bigint := 0;
  v_held_before numeric; v_held_after numeric; v_supply numeric;
  v_share bigint; v_rest bigint; v_take bigint; v_i integer := 0; v_wallet bigint; v_journal uuid; v_req uuid;
  v_journals uuid[] := ARRAY[]::uuid[]; v_registered numeric; v_legs jsonb := '[]'::jsonb; v_drained jsonb;
  v_blinds jsonb; v_payouts jsonb; v_manifest jsonb; v_hash text; v_receipt jsonb; v_stamped integer;
  v_played_recovery boolean := false; v_recovery jsonb;
BEGIN
  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;
  -- fn_spin_draw_and_settle_atomic proved the lease, the incomplete launch
  -- receipt of this launch and the maintenance freeze, and holds the receipt
  -- and the parent; this arm is reached from there and from nowhere else.
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND OR NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  IF v_t.variant IS DISTINCT FROM 'spin' OR upper(COALESCE(v_t.tournament_type,'')) <> 'SPIN'
     OR v_t.max_players IS DISTINCT FROM 3 OR v_t.format_contract IS DISTINCT FROM 'spin-v1'
     OR COALESCE(v_t.buy_in_amount, 0) < 1 OR v_t.buy_in_amount <> trunc(v_t.buy_in_amount)
     OR COALESCE(v_t.buy_in_fee, 0) <> 0 OR COALESCE(v_t.bounty_amount, 0) <> 0
     OR v_t.status IS DISTINCT FROM 'REGISTERING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_spin_contract');
  END IF;
  v_b := v_t.buy_in_amount::bigint;
  v_collected := 3 * v_b;
  SELECT * INTO v_k FROM public.poker_diamond_spin_contracts k WHERE k.tournament_id = p_tournament_id;
  IF NOT FOUND OR v_k.buy_in IS DISTINCT FROM v_b OR v_k.starting_chips IS DISTINCT FROM v_t.starting_chips
     OR v_k.rule_sha256 IS DISTINCT FROM encode(extensions.digest(v_k.rule_manifest::text, 'sha256'), 'hex') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_spin_contract_missing');
  END IF;

  -- The field: three distinct identities, read in the chip authority's order.
  SELECT count(*), count(DISTINCT p.user_id),
         jsonb_agg(jsonb_build_object('registration_id', p.id, 'user_id', p.user_id) ORDER BY p.user_id, p.id)
    INTO v_count, v_distinct, v_entrants
    FROM public.tournament_players p
   WHERE p.tournament_id = p_tournament_id AND p.status IN ('registered', 'playing');
  -- A DEALT SPIN MAY HAVE ONE PROVEN BUSTED AND VACATED ORIGINAL SEAT, as the
  -- chip authority rules. fn_prove_played_spin_launch_recovery (its Diamond
  -- arm: the three entries in custody, the committed draw and its banks) must
  -- prove the original three paid identities, a persisted hand, two exact
  -- live seats and all three bought stacks conserved; then the field is the
  -- original three, the bust included, and the committed receipt below
  -- replays. A fresh two-player field proves nothing and is refused.
  IF v_count = 2 THEN
    v_recovery := public.fn_prove_played_spin_launch_recovery(p_tournament_id);
    IF COALESCE((v_recovery->>'ok')::boolean, false) THEN
      v_played_recovery := true;
      SELECT count(*), count(DISTINCT p.user_id),
             jsonb_agg(jsonb_build_object('registration_id', p.id, 'user_id', p.user_id) ORDER BY p.user_id, p.id)
        INTO v_count, v_distinct, v_entrants
        FROM public.tournament_players p
       WHERE p.tournament_id = p_tournament_id AND p.status IN ('playing', 'eliminated');
    END IF;
  END IF;
  IF v_count <> 3 OR v_distinct <> 3 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'spin_field_unproven');
  END IF;

  -- A committed result is the answer: a new owner or a newer binary cannot
  -- reroll it or rewrite it, and nothing moves twice.
  SELECT * INTO v_saved FROM public.spin_draw_receipts r WHERE r.tournament_id = p_tournament_id;
  IF FOUND THEN
    IF v_saved.launch_id IS DISTINCT FROM p_launch_id OR v_saved.entrants IS DISTINCT FROM v_entrants THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_receipt_roster_mismatch');
    END IF;
    RETURN v_saved.receipt || jsonb_build_object('replay', true);
  END IF;

  -- Each of the three holds exactly one whole entry of the buy-in, active, in
  -- its own custody, and the event has moved nothing but entries and refunds.
  IF EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
              WHERE l.tournament_id = p_tournament_id AND l.kind NOT IN ('entry', 'refund')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'spin_paid_entry_unproven');
  END IF;
  FOR v_p IN SELECT p.id, p.user_id FROM public.tournament_players p
              WHERE p.tournament_id = p_tournament_id
                AND (p.status IN ('registered', 'playing')
                     OR (v_played_recovery AND p.status = 'eliminated'))
              ORDER BY p.user_id, p.id LOOP
    SELECT count(*) INTO v_rows_held FROM public.poker_diamond_custody c
     WHERE c.user_id = v_p.user_id AND c.purpose = 'tournament_entry'
       AND c.target_id = p_tournament_id AND c.state <> 'released';
    IF v_rows_held <> 1 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_paid_entry_unproven');
    END IF;
    SELECT c.* INTO v_c FROM public.poker_diamond_custody c
     WHERE c.user_id = v_p.user_id AND c.purpose = 'tournament_entry'
       AND c.target_id = p_tournament_id AND c.state <> 'released'
     FOR UPDATE;
    IF v_c.state IS DISTINCT FROM 'active' OR v_c.balance IS DISTINCT FROM v_b
       OR v_c.entry_key IS DISTINCT FROM 'entry:' || v_p.id::text
       OR (SELECT count(*) FROM public.poker_diamond_tournament_ledger l WHERE l.custody_id = v_c.id) <> 1
       OR NOT EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
                       WHERE l.custody_id = v_c.id AND l.kind = 'entry' AND l.user_id = v_p.user_id
                         AND l.registration_id = v_p.id AND l.amount = v_b AND l.prize_part = v_b
                         AND l.bounty_part = 0 AND l.fee_part = 0) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_paid_entry_unproven');
    END IF;
  END LOOP;
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
  IF v_e.prize_balance IS DISTINCT FROM v_collected::numeric OR v_e.bounty_balance <> 0 OR v_e.fee_balance <> 0
     OR public.fn_poker_diamond_tournament_custody(p_tournament_id) IS DISTINCT FROM v_collected THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'spin_entry_escrow_unproven');
  END IF;

  -- The reserve: the authorized source, the cap it was authorized with, and a
  -- balance that covers the whole pinned table. All or nothing: a Diamond Spin
  -- never draws from a table with tiers locked out, so what was advertised is
  -- what is drawn from. Nothing has moved yet, so each refusal is an answer.
  SELECT * INTO v_source FROM public.poker_diamond_spin_reserve_source WHERE id = 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_spin_reserve_source_not_authorized');
  END IF;
  v_worst := v_k.worst_excess;
  v_cover := v_k.required_cover;
  IF v_worst > v_source.max_underwrite_per_spin THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_spin_reserve_over_its_authorized_cap',
      'worst_excess', v_worst, 'max_underwrite_per_spin', v_source.max_underwrite_per_spin);
  END IF;
  INSERT INTO public.ca_diamond_house (id, balance) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
  SELECT COALESCE(h.balance, 0) INTO v_held_before FROM public.ca_diamond_house h WHERE h.id = 1 FOR UPDATE;
  IF COALESCE(v_held_before, 0) < v_cover THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_spin_reserve_cannot_cover_the_table',
      'required_cover', v_cover, 'source_balance', COALESCE(v_held_before, 0));
  END IF;

  -- THE DRAW: one roll of the database's own cryptographic generator over the
  -- pinned table, the arithmetic fn_spin_draw_multiplier rolls with. The
  -- engine's compiled manifest is not an input.
  SELECT COALESCE(sum((t.value->>'freq')::numeric), 0), count(*)
    INTO v_total, v_tiers FROM jsonb_array_elements(v_k.rule_manifest->'tiers') t;
  v_roll := (('x' || encode(extensions.gen_random_bytes(6), 'hex'))::bit(48)::bigint)::numeric
            / 281474976710656::numeric * v_total;
  FOR v_x IN SELECT t.value, t.ordinality FROM jsonb_array_elements(v_k.rule_manifest->'tiers') WITH ORDINALITY t
              ORDER BY t.ordinality LOOP
    v_acc := v_acc + (v_x.value->>'freq')::numeric;
    IF v_roll < v_acc THEN v_pick := (v_x.value->>'multiplier')::numeric; v_tier := v_x.value; EXIT; END IF;
  END LOOP;
  IF v_pick IS NULL THEN
    v_tier := v_k.rule_manifest->'tiers'->(jsonb_array_length(v_k.rule_manifest->'tiers') - 1);
    v_pick := (v_tier->>'multiplier')::numeric;
  END IF;

  -- THE POOL AT THE UNIT: the multiplier times the buy-in floored to a whole
  -- Diamond, and every leg below is computed from that floored pool, so a
  -- residue could only ever stay with the source. The contract admitted only
  -- tables with none; it is proved here before anything moves.
  v_cents := v_pick * v_b * 100;
  v_prize := public.fn_ca_unit_floor_cents(trunc(v_cents)::bigint, 100) / 100;
  v_residue := v_cents - v_prize * 100;
  IF v_residue <> 0 OR v_prize < 1 THEN
    RAISE EXCEPTION 'diamond_spin_prize_not_whole_at_the_unit: %x at % Diamonds leaves % cents', v_pick, v_b, v_residue
      USING ERRCODE='P0404';
  END IF;

  IF v_prize > v_collected THEN
    -- THE SOURCE UNDERWRITES the pool above the three entries, into the
    -- event's custody before it may launch: a house burn on the register, and
    -- a player-side register mint for each custody share it lands in, split
    -- as evenly as whole Diamonds allow (the remainder to the earliest entries).
    v_underwrite := v_prize - v_collected;
    UPDATE public.ca_diamond_house SET balance = balance - v_underwrite, updated_at = now()
     WHERE id = 1 RETURNING balance INTO v_held_after;
    SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0) INTO v_supply
      FROM public.ca_mint_ledger m WHERE m.asset = 'diamonds';
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after, reason)
    VALUES
      ('poker-spin-underwrite:' || p_tournament_id::text, 'burn', 'diamonds', 'house', c_house, 'the house',
       v_underwrite, v_held_before, v_held_after, v_supply - v_underwrite,
       'Diamond Spin prize pool underwritten from the house into the event custody ('
       || COALESCE(v_t.name, 'spin') || ', ' || v_pick || 'x), DR14 (poker_spin_underwrite)');
    SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry IMMEDIATE;
    v_share := v_underwrite / 3;
    v_rest := v_underwrite % 3;
    FOR v_c IN SELECT c.* FROM public.poker_diamond_custody c
                WHERE c.purpose = 'tournament_entry' AND c.target_id = p_tournament_id AND c.state = 'active'
                ORDER BY c.created_at, c.id FOR UPDATE LOOP
      v_i := v_i + 1;
      v_take := v_share + CASE WHEN v_i <= v_rest THEN 1 ELSE 0 END;
      CONTINUE WHEN v_take = 0;
      SELECT COALESCE(pr.diamonds, 0) INTO v_wallet FROM public.profiles pr WHERE pr.id = v_c.user_id;
      -- The wallet does not move (balance_after is the wallet as it stands):
      -- the share lands in custody and is paid out only as a prize. Class
      -- 'arena': the register follows it, the earn ledger does not (a prize
      -- pool is not a reward any daily cap may shorten).
      INSERT INTO public.diamond_transactions(user_id, type, transaction_type, amount, balance_after, reference_id,
        description, source, issuance_class, counterparty, metadata)
      VALUES (v_c.user_id, 'arena_spin_underwrite', 'arena_spin_underwrite', v_take::integer, v_wallet,
        'poker-spin-underwrite:' || p_tournament_id::text || ':' || v_c.id::text,
        'Diamond Spin prize pool: ' || COALESCE(v_t.name, 'spin') || ' drew ' || v_pick
          || 'x; the house underwrote this share into the entry custody (paid out as prizes, never spendable)',
        'poker_arena', 'arena', 'house',
        jsonb_build_object('custody_id', v_c.id, 'tournament_id', p_tournament_id, 'source', 'house',
                           'destination', 'custody', 'multiplier', v_pick))
      RETURNING id INTO v_journal;
      v_journals := v_journals || v_journal;
      v_req := uuid_in(md5('poker-spin-underwrite:' || p_tournament_id::text || ':' || v_c.id::text)::cstring);
      -- The movement first, then the balance (P0814 is checked at the update).
      INSERT INTO public.poker_diamond_movements(request_id, custody_id, user_id, action, amount,
        source_account, destination_account, wallet_journal_id, request, receipt)
      VALUES (v_req, v_c.id, v_c.user_id, 'reserve', v_take, 'house:' || c_house::text, 'arena_custody:' || v_c.id::text,
        v_journal,
        jsonb_build_object('action', 'spin_underwrite', 'bank', 'prize', 'tournament_id', p_tournament_id,
                           'custody_id', v_c.id, 'amount', v_take),
        jsonb_build_object('success', true, 'custody_id', v_c.id, 'amount', v_take,
                           'custody_balance', v_c.balance + v_take, 'journal_id', v_journal));
      UPDATE public.poker_diamond_custody SET balance = balance + v_take WHERE id = v_c.id;
      INSERT INTO public.poker_diamond_tournament_ledger(tournament_id, arena_id, user_id, custody_id, kind, amount,
        prize_part, bounty_part, fee_part, idempotency_key, wallet_journal_id, request)
      VALUES (p_tournament_id, v_t.club_id, v_c.user_id, v_c.id, 'spin_underwrite', v_take, v_take, 0, 0,
        'poker-spin-underwrite:' || p_tournament_id::text || ':' || v_c.id::text, v_journal,
        jsonb_build_object('kind', 'spin_underwrite', 'multiplier', v_pick, 'source', 'house', 'request_id', v_req));
      v_legs := v_legs || jsonb_build_array(jsonb_build_object('custody_id', v_c.id, 'user_id', v_c.user_id,
                  'amount', v_take, 'journal_id', v_journal, 'leg', 'spin_underwrite'));
    END LOOP;
    SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry DEFERRED;
    SELECT COALESCE(sum(m.amount), 0) INTO v_registered FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.action = 'mint' AND m.holder_type = 'player'
       AND m.diamond_tx_id = ANY (v_journals);
    IF v_registered IS DISTINCT FROM v_underwrite::numeric THEN
      RAISE EXCEPTION 'diamond_spin_underwrite_not_registered_to_players (% of %)', v_registered, v_underwrite
        USING ERRCODE='P0404';
    END IF;
  ELSIF v_prize < v_collected THEN
    -- THE SURPLUS RETURNS to the source: the entries above the pool leave the
    -- prize bank through the drain (each player's share journaled as that
    -- player's spend, which the register retires) and the house is minted
    -- exactly that, as the Phase 8 fee settlement banks a fee.
    v_surplus := v_collected - v_prize;
    v_drained := public.fn_poker_diamond_tournament_drain(p_tournament_id, 'prize', v_surplus,
                   'poker-spin-surplus:' || p_tournament_id::text, 'house', NULL);
    SELECT COALESCE(sum(m.amount), 0) INTO v_registered FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.action = 'burn' AND m.holder_type = 'player'
       AND m.diamond_tx_id IN (SELECT (d->>'journal_id')::uuid FROM jsonb_array_elements(v_drained) d);
    IF v_registered IS DISTINCT FROM v_surplus::numeric THEN
      RAISE EXCEPTION 'diamond_spin_surplus_not_retired_from_players (% of %)', v_registered, v_surplus
        USING ERRCODE='P0404';
    END IF;
    UPDATE public.ca_diamond_house SET balance = balance + v_surplus, updated_at = now()
     WHERE id = 1 RETURNING balance INTO v_held_after;
    SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0) INTO v_supply
      FROM public.ca_mint_ledger m WHERE m.asset = 'diamonds';
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after, reason)
    VALUES
      ('poker-spin-surplus:' || p_tournament_id::text, 'mint', 'diamonds', 'house', c_house, 'the house',
       v_surplus, v_held_before, v_held_after, v_supply + v_surplus,
       'Diamond Spin entries above the drawn prize pool returned from the event custody to the house ('
       || COALESCE(v_t.name, 'spin') || ', ' || v_pick || 'x), DR14 (poker_spin_surplus)');
    FOR v_d IN SELECT d.value FROM jsonb_array_elements(v_drained) d LOOP
      INSERT INTO public.poker_diamond_tournament_ledger(tournament_id, arena_id, user_id, custody_id, kind, amount,
        prize_part, bounty_part, fee_part, idempotency_key, wallet_journal_id, request)
      VALUES (p_tournament_id, v_t.club_id, (v_d->>'user_id')::uuid, (v_d->>'custody_id')::uuid, 'spin_surplus',
        (v_d->>'amount')::bigint, (v_d->>'amount')::bigint, 0, 0,
        'poker-spin-surplus:' || p_tournament_id::text || ':' || (v_d->>'custody_id'), (v_d->>'journal_id')::uuid,
        jsonb_build_object('kind', 'spin_surplus', 'multiplier', v_pick, 'destination', 'house',
                           'request_id', v_d->>'request_id'));
      v_legs := v_legs || jsonb_build_array(v_d || jsonb_build_object('leg', 'spin_surplus'));
    END LOOP;
  ELSE
    v_held_after := v_held_before;
  END IF;

  -- The banks and the custody agree, at the drawn pool, whole.
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
  IF v_e.prize_balance IS DISTINCT FROM v_prize::numeric OR v_e.bounty_balance <> 0 OR v_e.fee_balance <> 0
     OR public.fn_poker_diamond_tournament_custody(p_tournament_id) IS DISTINCT FROM v_prize THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE='P0404';
  END IF;
  -- An escrow shadow already open follows the legs, as a chip draw's does.
  IF EXISTS (SELECT 1 FROM public.tournament_escrow x WHERE x.tournament_id = p_tournament_id) THEN
    PERFORM public.fn_ca_escrow_apply(p_tournament_id, 'diamond spin reserve',
      p_reserve_out => v_surplus, p_reserve_in => v_underwrite);
  END IF;

  -- THE RECEIPT, in the chip receipt's shape (the engine reads both with one
  -- reader, readFundedSpinDraw), frozen with the code that drew it.
  v_blinds := v_tier->'blind_structure';
  v_payouts := v_tier->'payout_structure';
  v_manifest := v_k.rule_manifest || jsonb_build_object(
    'contract_sha256', v_k.rule_sha256,
    'draw_function_md5', md5(pg_get_functiondef('public.fn_poker_diamond_spin_draw(uuid,uuid,uuid)'::regprocedure)));
  v_hash := encode(extensions.digest(v_manifest::text, 'sha256'), 'hex');
  v_receipt := jsonb_build_object(
    'ok', true, 'replay', false, 'asset', 'diamonds', 'unit_cents', 100,
    'money_path', 'fn_poker_diamond_spin_draw',
    'tournament_id', p_tournament_id, 'launch_id', p_launch_id,
    'multiplier', v_pick, 'prize_pool', v_prize, 'buy_in', v_b, 'starting_chips', v_t.starting_chips,
    'blind_structure', v_blinds, 'payout_structure', v_payouts, 'locked', '[]'::jsonb, 'entrants', v_entrants,
    'rule_manifest', v_manifest, 'rule_sha256', v_hash, 'rule_provenance', 'at_draw',
    'collected', v_collected, 'house_rake', 0, 'underwrite', v_underwrite, 'surplus', v_surplus, 'residue', 0,
    'pool_covered', v_prize, 'operator_shortfall', 0, 'custody_legs', v_legs,
    'reserve_source', v_source.source_account,
    'source_balance_before', v_held_before, 'source_balance_after', v_held_after,
    'draw_inputs', jsonb_build_object('roll', v_roll, 'total_freq', v_total, 'eligible_count', v_tiers,
      'required_cover', v_cover, 'worst_excess', v_worst,
      'max_underwrite_per_spin', v_source.max_underwrite_per_spin, 'reserve_ruling', v_source.ruling));
  INSERT INTO public.spin_draw_receipts(tournament_id, launch_id, lease_generation,
    rule_manifest, rule_sha256, entrants, receipt)
  VALUES (p_tournament_id, p_launch_id, p_lease_generation, v_manifest, v_hash, v_entrants, v_receipt);

  -- The tournament row is the contract the engine, the ladder trigger and the
  -- launch proof read back, stamped in this transaction and read back exactly.
  UPDATE public.tournaments
     SET spin_multiplier   = v_pick,
         prize_pool        = v_prize,
         spin_locked_tiers = '[]'::jsonb,
         blind_structure   = v_blinds::text,
         payout_structure  = v_payouts::text
   WHERE id = p_tournament_id;
  GET DIAGNOSTICS v_stamped = ROW_COUNT;
  IF v_stamped <> 1 OR NOT EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id = p_tournament_id
          AND t.spin_multiplier IS NOT DISTINCT FROM v_pick
          AND t.prize_pool IS NOT DISTINCT FROM v_prize::numeric
          AND t.spin_locked_tiers IS NOT DISTINCT FROM '[]'::jsonb) THEN
    RAISE EXCEPTION 'Spin % tournament contract did not read back exactly', p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  RETURN v_receipt;
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_spin_draw(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. THE LOBBY READS A DIAMOND SPIN'S OWN TOP MULTIPLIER
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_spin_ceilings(p_tournament_ids uuid[])
 RETURNS TABLE(tournament_id uuid, max_multiplier numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The top of the table each Diamond Spin was created with and draws from
  -- (poker_diamond_spin_contracts, pinned by sha256), which its lobby card
  -- advertises before the draw: the arithmetic the creation door answers
  -- max_multiplier with. Any other id answers nothing; the lobby keeps the
  -- chip ladder's ceiling for a chip Spin. At most 500 ids a call.
  SELECT k.tournament_id, max((x.value->>'multiplier')::numeric)
    FROM public.poker_diamond_spin_contracts k
    CROSS JOIN LATERAL jsonb_array_elements(k.rule_manifest->'tiers') x
   WHERE k.tournament_id = ANY (p_tournament_ids[1:500])
     AND public.fn_poker_diamond_tournament(k.tournament_id)
   GROUP BY k.tournament_id;
$function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_spin_ceilings(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_spin_ceilings(uuid[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE r record; v_bad text;
BEGIN
  -- every edit landed exactly as generated
  FOR r IN SELECT * FROM (VALUES
      ('public.fn_prove_played_spin_launch_recovery(uuid)', '24fdb3e367523189ed08599791b3b3fc'),
      ('public.fn_poker_diamond_prove_played_spin_launch_recovery(uuid)', '40b21208f4bd1de6f345311ca161cff5'),
      ('public.fn_poker_diamond_spin_draw(uuid, uuid, uuid)', 'd5dd637ae71afa08b5c27c042f9eb1c2'),
      ('public.fn_poker_diamond_spin_ceilings(uuid[])', 'a629eb9b56f96e5229d4d73289b285d7')
    ) AS x(sig, want) LOOP
    IF md5(pg_get_functiondef(r.sig::regprocedure)) IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION '% is not the text this migration wrote (md5 %)', r.sig, md5(pg_get_functiondef(r.sig::regprocedure));
    END IF;
  END LOOP;
  -- both database callers still ask the one played-Spin proof
  IF position('public.fn_prove_played_spin_launch_recovery(p_tournament_id)'
       IN pg_get_functiondef('public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)'::regprocedure)) = 0
     OR position('public.fn_prove_played_spin_launch_recovery(p_tournament_id)'
       IN pg_get_functiondef('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'a caller no longer asks the played-Spin proof';
  END IF;
  -- the proof keeps its grants: the engine asks it, no browser does; its
  -- Diamond arm and the draw arm are owner-only; the lobby read is for
  -- signed-in players and never anonymous
  IF NOT has_function_privilege('service_role', 'public.fn_prove_played_spin_launch_recovery(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_prove_played_spin_launch_recovery(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_prove_played_spin_launch_recovery(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the played-Spin proof changed its grants';
  END IF;
  FOR r IN SELECT x.sig FROM (VALUES
      ('public.fn_poker_diamond_prove_played_spin_launch_recovery(uuid)'),
      ('public.fn_poker_diamond_spin_draw(uuid, uuid, uuid)')) AS x(sig) LOOP
    IF has_function_privilege('anon', r.sig, 'EXECUTE') OR has_function_privilege('authenticated', r.sig, 'EXECUTE')
       OR has_function_privilege('service_role', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable from outside; it is owner-only', r.sig;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.fn_poker_diamond_spin_ceilings(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_poker_diamond_spin_ceilings(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'the lobby read is anonymous, or a signed-in player cannot ask it';
  END IF;
  IF has_table_privilege('authenticated', 'public.poker_diamond_spin_contracts', 'SELECT')
     OR has_table_privilege('anon', 'public.poker_diamond_spin_contracts', 'SELECT') THEN
    RAISE EXCEPTION 'the pinned Spin contracts became readable from a browser';
  END IF;
  -- nothing is authorized, nothing is opened, the identity is whole, every
  -- watched guard is on its baseline
  IF EXISTS (SELECT 1 FROM public.poker_diamond_spin_reserve_source) THEN
    RAISE EXCEPTION 'this migration must not authorize a reserve source';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open the tournament door';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'a Diamond Spin recovers and shows its top prize: the played-Spin proof reads a Diamond Spin''s own evidence, its draw arm replays for the proven field, the lobby reads its own top multiplier, nothing authorized and nothing opened';
END $m$;
