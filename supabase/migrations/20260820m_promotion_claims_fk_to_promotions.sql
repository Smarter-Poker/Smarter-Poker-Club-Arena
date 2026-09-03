-- PromotionService.getUserClaims() embedded `promotions(title, type)` on
-- promotion_claims. PostgREST can only embed across a real FOREIGN KEY, and
-- promotion_claims had none at all, so the request returned
--   400 PGRST200 "Could not find a relationship between 'promotion_claims'
--   and 'promotions' in the schema cache"
-- on every call. getUserClaims did `if (error) return []`, so a user's claimed
-- promotions were silently invisible for as long as this has existed. Caught
-- 2026-08-20 by a smoke test that started visiting the real pages instead of a
-- doubled base path that 404'd.
--
-- The embed itself has been REMOVED in the same change (mapClaim never read it
-- and `promotions` has no `title` column — it is `name`), so this constraint is
-- no longer load-bearing for that query. It is kept because promotion_claims
-- carries bonus_amount and pointed at promotions with nothing enforcing that
-- the promotion exists.
--
-- Safe to add: promotion_claims holds 0 rows and 0 orphans, and both columns
-- are uuid, so NOT VALID is unnecessary at this size.
--
-- ON DELETE CASCADE matches the semantics — a claim against a deleted
-- promotion is meaningless, and leaving it would recreate the orphan state
-- this constraint exists to prevent.
alter table public.promotion_claims
  add constraint promotion_claims_promotion_id_fkey
  foreign key (promotion_id)
  references public.promotions (id)
  on delete cascade;

-- PostgREST resolves embeds from its schema cache; without this the change
-- only takes effect on the next connection reload.
notify pgrst, 'reload schema';
