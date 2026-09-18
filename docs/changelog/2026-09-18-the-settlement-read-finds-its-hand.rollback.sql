-- Rollback for 20260918002945_the_settlement_read_finds_its_hand.sql
--
-- Removing this index returns fn_cash_accept_hand_provenance to a parallel
-- sequential scan of 6.6 GB per dealt cash hand: 9.7 s and 484,321 buffers
-- per call, measured on 2026-09-18, with the whole platform timing out behind
-- it. There is no reason to run this.

DROP INDEX CONCURRENTLY IF EXISTS public.idx_ca_settlements_table_hand;
