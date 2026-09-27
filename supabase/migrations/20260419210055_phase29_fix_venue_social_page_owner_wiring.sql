-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419210055 "phase29_fix_venue_social_page_owner_wiring"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7d7dd494dd295e1e4c7d9c3d651649e5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: the auto-created venue social_page should have owner_id = claimed_by
-- In BEFORE UPDATE trigger, NEW.claimed_by is what the row will become.
-- We pass it explicitly so the helper can set owner_id correctly.
CREATE OR REPLACE FUNCTION public.trg_fn_venue_claim_wiring()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_social_page_id uuid;
BEGIN
    IF COALESCE(OLD.is_claimed, false) = false AND COALESCE(NEW.is_claimed, false) = true THEN
        -- 1. Auto-enable Commander
        IF NOT COALESCE(NEW.commander_enabled, false) THEN
            NEW.commander_enabled := true;
            IF NEW.commander_activated_at IS NULL THEN NEW.commander_activated_at := now(); END IF;
        END IF;
        -- 2. Ensure social_page exists (may have owner_id=null because claimed_by isn't committed yet)
        v_social_page_id := public.fn_ensure_social_page_for_venue(NEW.id);
        -- 3. Force-set owner_id to the incoming claimed_by on the social_page
        IF v_social_page_id IS NOT NULL AND NEW.claimed_by IS NOT NULL THEN
            UPDATE social_pages 
               SET owner_id = NEW.claimed_by,
                   metadata = COALESCE(metadata, '{}'::jsonb) 
                              || jsonb_build_object('is_claimed', true, 
                                                    'claim_wired_at', now())
             WHERE id = v_social_page_id;
        END IF;
    END IF;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'venue claim wiring failed for venue %: %', NEW.id, SQLERRM;
    RETURN NEW;
END; $fn$;

-- One-time backfill: the Orleans Casino social_page we just created has owner_id=null
UPDATE social_pages 
   SET owner_id = (SELECT claimed_by FROM poker_venues WHERE id = 1988),
       metadata = COALESCE(metadata, '{}'::jsonb) 
                  || jsonb_build_object('is_claimed', true, 
                                        'claim_wired_at', now(),
                                        'backfilled_owner', true)
 WHERE linked_entity_type = 'venue' AND linked_entity_id = '1988'
   AND owner_id IS NULL;
