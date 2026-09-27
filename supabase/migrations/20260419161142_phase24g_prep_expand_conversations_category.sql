-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419161142 "phase24g_prep_expand_conversations_category"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f5743d179e6e7e407588f1f4c245c50e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Expand conversations.category CHECK to accept 'home_group' 
-- (additive only; existing 'personal' and 'club' rows unaffected)
ALTER TABLE public.conversations 
    DROP CONSTRAINT IF EXISTS conversations_category_check;

ALTER TABLE public.conversations
    ADD CONSTRAINT conversations_category_check 
    CHECK (category = ANY (ARRAY['personal'::text, 'club'::text, 'home_group'::text]));
