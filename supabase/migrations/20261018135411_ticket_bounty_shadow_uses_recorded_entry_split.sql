-- Ticket entries retain their recorded bounty split in the chip escrow shadow.
-- Two tickets into Saturday Mystery each carried entry_bounty=8; the maintained
-- escrow correctly recorded16 while this read-only shadow assigned it to prizes.
-- No wallet, payout, rate, maintained escrow or settled history is changed.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $migration$
DECLARE source text;patched text;
BEGIN
 source:=pg_get_functiondef('public.fn_ca_tournament_escrow_chips(uuid)'::regprocedure);
 IF md5(source)<>'0a2f5a27ed0e25e22b9d006f29b3b942' THEN RAISE EXCEPTION 'ticket bounty shadow preimage changed'; END IF;
 patched:=replace(source,$a$SELECT COALESCE(sum(amount),0) AS ticket_in$a$,$b$SELECT COALESCE(sum(amount),0) AS ticket_in,
         COALESCE(sum((metadata->>'entry_bounty')::numeric),0) AS ticket_bounty$b$);
 patched:=replace(patched,$a$round(direct_bounty.amount+stl.split_bounty,2) AS bounty_in$a$,$b$round(direct_bounty.amount+stl.split_bounty+tk.ticket_bounty,2) AS bounty_in$b$);
 IF patched=source THEN RAISE EXCEPTION 'ticket bounty shadow anchor missing';END IF;
 EXECUTE patched;
 IF pg_get_functiondef('public.fn_ca_tournament_escrow_chips(uuid)'::regprocedure) IS DISTINCT FROM patched
 THEN RAISE EXCEPTION 'ticket bounty shadow readback mismatch';END IF;
END $migration$;
COMMIT;
