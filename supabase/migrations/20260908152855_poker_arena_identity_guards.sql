-- Phase 2 access rollout. No Diamond custody or gameplay is enabled.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- Preserve the legacy identity row, but it is not a private club membership or an owner grant.
-- Refuse this migration if any old wallet has an unresolved monetary balance.
DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM public.club_members m JOIN public.clubs c ON c.id=m.club_id
     WHERE c.asset='diamonds' AND (coalesce(m.chip_balance,0)<>0 OR coalesce(m.credit_used,0)<>0
       OR coalesce(m.promo_balance,0)<>0 OR coalesce(m.held_chips,0)<>0)) THEN
    RAISE EXCEPTION 'Reconcile Existing Diamond Arena Obligations Before Changing Identity';
  END IF;
END $preflight$;


CREATE UNIQUE INDEX poker_arena_one_diamond_identity ON public.clubs(asset) WHERE asset='diamonds';

ALTER TABLE public.clubs ADD CONSTRAINT poker_arena_diamond_identity CHECK (
  (asset='chips' AND NOT is_platform) OR
  (asset='diamonds' AND is_platform AND union_id IS NULL AND NOT coalesce(is_union,false)
    AND coalesce(chip_treasury,0)=0 AND coalesce(chip_pool,0)=0 AND coalesce(promo_balance,0)=0
    AND coalesce(insurance_balance,0)=0));

CREATE TRIGGER poker_arena_identity_guard BEFORE INSERT OR UPDATE ON public.clubs
FOR EACH ROW EXECUTE FUNCTION public.fn_poker_guard_arena_structure();
CREATE TRIGGER poker_arena_membership_guard BEFORE INSERT OR UPDATE ON public.club_members
FOR EACH ROW EXECUTE FUNCTION public.fn_poker_guard_arena_structure();
-- Data transition follows DDL so deferred counter triggers cannot block ALTER TABLE.
UPDATE public.club_members m SET role='player', status='automatic', credit_limit=0,
  agent_id=NULL, parent_agent_id=NULL
FROM public.clubs c WHERE c.id=m.club_id AND c.asset='diamonds';
