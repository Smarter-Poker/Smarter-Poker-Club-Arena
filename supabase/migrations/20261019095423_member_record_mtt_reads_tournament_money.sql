-- 20261019095423_member_record_mtt_reads_tournament_money
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-19 09:54:23 UTC.
--
-- MEMBER RECORD MTT WINNINGS ARE TOURNAMENT MONEY, AND WIN/LOSS READS AN INDEX
--
-- 1. The member record (ca_club_member_detail) showed stats.mtt_winnings as the
--    sum of member_record_daily_facts.net over tournament hands. That is the
--    change in tournament STACK chips, not money: a Club JAQK member read
--    about -1.96M while the tournament money they actually won and lost
--    (prizes paid minus buy-ins on chip_ledger,
--    ca_club_member_tournament_money) was about -1,114.51. The Win/Loss card
--    already used tournament money, so the two screens disagreed. The record
--    now reads ca_club_member_tournament_money for the same club, member and
--    UTC calendar range (from = p_from 00:00 UTC, to = p_to + 1 day 00:00 UTC;
--    NULL is unbounded), so record and Win/Loss "overall" agree exactly.
--    Cash winnings, hands, fees and transaction totals are unchanged.
--
-- 2. ca_club_members_win_loss / ca_club_member_win_loss hit about 1,345
--    statement timeouts in 24 hours. Each member's tournament money read
--    walked idx_chip_ledger_club_to_created / _club_from_created and fetched
--    every leg of that member from the 7 GB heap to test the leg type
--    (measured 2026-10-19 on a heavy Club JAQK member: 5,039 legs, 5,185
--    pages read, 3.3 s; ca_club_member_win_loss 5.1 s). Two partial covering
--    indexes hold exactly the two tournament legs keyed (club, member,
--    created_at) INCLUDE (amount, tournament_id), so the sum is an index-only
--    scan. tournament_id is included so a per-game reader can join the
--    tournament without a heap fetch.
--
-- LOCKS. chip_ledger is written on every hand, so a plain CREATE INDEX would
-- stall live play. The two indexes are the sanctioned concurrent preamble
-- (scripts/ci/migration-concurrent-preamble.mjs): apply-merged-migration sends
-- each alone outside any transaction, only with runway before :50 UTC, and
-- reads it back VALID before the transaction below, which refuses unless both
-- are valid. idx_chip_ledger_correlation_id was built the same way on
-- 2026-10-17 in 150 s. Never drop a failed build blindly; inspect it first.
--
-- @live-proof: (SELECT count(*)=2 AND bool_and(i.indisvalid AND i.indisready AND i.indislive) FROM pg_index i WHERE i.indexrelid IN (to_regclass('public.idx_chip_ledger_tournament_prize_to_player'),to_regclass('public.idx_chip_ledger_tournament_entry_from_player'))) AND position('ca_club_member_tournament_money(p_club_id, p_user_id, v_ts_from, v_ts_to)' IN pg_get_functiondef('public.ca_club_member_detail(uuid,uuid,date,date)'::regprocedure))>0

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_tournament_prize_to_player
  ON public.chip_ledger (club_id, to_entity_id, created_at)
  INCLUDE (amount, tournament_id)
  WHERE tournament_id IS NOT NULL AND status = 'posted'
    AND from_type = 'prize_liability' AND to_type = 'player_wallet';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_tournament_entry_from_player
  ON public.chip_ledger (club_id, from_entity_id, created_at)
  INCLUDE (amount, tournament_id)
  WHERE tournament_id IS NOT NULL AND status = 'posted'
    AND from_type = 'player_wallet' AND to_type = 'prize_liability';

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $assert$
BEGIN
  IF (SELECT count(*) FROM pg_index i
       WHERE i.indexrelid IN (to_regclass('public.idx_chip_ledger_tournament_prize_to_player'),
                              to_regclass('public.idx_chip_ledger_tournament_entry_from_player'))
         AND i.indrelid = 'public.chip_ledger'::regclass
         AND i.indisvalid AND i.indisready AND i.indislive) <> 2
  OR to_regclass('public.idx_chip_ledger_tournament_prize_to_player_ccnew') IS NOT NULL
  OR to_regclass('public.idx_chip_ledger_tournament_entry_from_player_ccnew') IS NOT NULL
  THEN
    RAISE EXCEPTION 'TOURNAMENT_MONEY_COVERING_INDEXES_NOT_VALID';
  END IF;
END $assert$;
DO $patch$
DECLARE d text; original text; old_source text; new_source text;
BEGIN
 SELECT pg_get_functiondef('public.ca_club_member_detail(uuid,uuid,date,date)'::regprocedure) INTO original;
 IF md5(original)<>'28abd1d6303633908a7599ca66298716' THEN
   RAISE EXCEPTION 'Member detail source preimage changed; qualify current definition';
 END IF;
 old_source:=$old$      coalesce(sum(r.net) FILTER(WHERE NOT r.is_mtt),0) net,
      coalesce(sum(r.net) FILTER(WHERE r.is_mtt),0) mtt_net
$old$;
 new_source:=$new$      coalesce(sum(r.net) FILTER(WHERE NOT r.is_mtt),0) net
$new$;
 IF strpos(original,old_source)=0 THEN RAISE EXCEPTION 'Member detail tournament chip net preimage missing'; END IF;
 d:=replace(original,old_source,new_source);
 -- Tournament money: prizes paid minus buy-ins for the same club, member and
 -- UTC range, the definition the Win/Loss card already uses.
 old_source:=$old$'mtt_winnings', round(coalesce(rl.mtt_net, 0), 2),$old$;
 new_source:=$new$'mtt_winnings', round(coalesce(public.ca_club_member_tournament_money(p_club_id, p_user_id, v_ts_from, v_ts_to), 0), 2),$new$;
 IF strpos(d,old_source)=0 THEN RAISE EXCEPTION 'Member detail MTT winnings preimage missing'; END IF;
 EXECUTE replace(d,old_source,new_source);
END $patch$;
COMMIT;
