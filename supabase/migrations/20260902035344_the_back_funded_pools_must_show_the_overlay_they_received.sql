-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902035344; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- back_fund_the_six_unfunded_guarantees paid the players and debited the main
-- bank, but never raised tournaments.prize_pool to the guarantee. The live
-- trigger does exactly that (NEW.prize_pool := pool + shortfall); the backfill
-- did not, so the four events it paid now read:
--
--   Union Grand Championship   pool 2,040   guarantee 2,500   credited 2,500
--   Union Mystery Bounty       pool   450   guarantee   800   credited   800
--   Evening Mystery Bounty     pool   225   guarantee   400   credited   400
--   Turbo Tuesday Opener       pool   234   guarantee   250   credited   250
--
-- Credited equals the guarantee, which is right. The pool does not, which is
-- wrong: the bank paid the overlay in and the pool has to show it. Every
-- overpay detector compares credits against prize_pool, so FeeReconciler has
-- been filing a fresh critical every hour about money that is correctly paid -
-- 1,011 chips of "excess" that is really my own missing bookkeeping entry.
--
-- Raising the pool to the guarantee is not a payment; the chips already moved.
-- It records where they landed. Scoped strictly to events this session
-- back-funded, identified by their own wallet_transactions receipts, so it can
-- never touch an event whose pool is genuinely different from its guarantee.
--
-- (Late Night Grind +3.21 and Brunch Special PKO +6.80 are NOT mine and are
-- left alone: they predate tonight and are real small overpays, already
-- carried by the prize_overpay ratchet.)

UPDATE public.tournaments t
   SET prize_pool = round(t.guaranteed_prize, 2)
 WHERE t.status = 'COMPLETED'
   AND COALESCE(t.guaranteed_prize,0) > COALESCE(t.prize_pool,0)
   AND EXISTS (
     SELECT 1 FROM public.wallet_transactions w
      WHERE w.related_entity_id = t.id
        AND w.description LIKE 'Guarantee overlay back-payment%')
   -- only where the players were actually brought up to the guarantee
   AND COALESCE((SELECT round(sum(w2.amount),2) FROM public.wallet_transactions w2
                  WHERE w2.related_entity_id = t.id AND w2.type='credit'
                    AND COALESCE(w2.category,'') <> 'bounty'), 0)
       >= round(t.guaranteed_prize,2) - 0.01;

