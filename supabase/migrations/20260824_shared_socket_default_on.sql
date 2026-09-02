-- Shared engine socket leaves beta and becomes the DEFAULT transport.
--
-- Dan, 2026-08-24 (binding): per-join TLS handshakes (300-600ms each) were
-- plaguing every table join globally. The /ws/multi mux shipped 2026-08-21
-- with unit coverage on both client and server; the client default flips in
-- the same commit as this migration (DEFAULT_USER_TABLE_SETTINGS and
-- isMuxEnabled now default ON, with localStorage ca_ws_mux='0' as the kill
-- switch driven by the existing settings toggle).
--
-- Existing rows are updated too, not just the column default: the toggle only
-- shipped on 2026-08-21 default-false, so a stored false is overwhelmingly
-- "never touched it", not an informed opt-out. Anyone who genuinely prefers
-- per-table sockets flips the toggle once and their choice sticks — the
-- per-key upsert path persists it and the mirror writes ca_ws_mux='0'.
--
-- Tier 2. Applied to production via Supabase MCP apply_migration on
-- 2026-08-24 before this branch merged (CHECK 17). Pinned client-side by
-- tests/user-table-settings-defaults.test.ts.

ALTER TABLE public.user_table_settings
  ALTER COLUMN multi_shared_socket SET DEFAULT true;

UPDATE public.user_table_settings
   SET multi_shared_socket = true
 WHERE multi_shared_socket = false;

-- ── Post-apply assertions ─────────────────────────────────────────────────────
DO $$
DECLARE
  v_default text;
  v_false_rows bigint;
BEGIN
  SELECT column_default INTO v_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'user_table_settings'
     AND column_name  = 'multi_shared_socket';
  IF v_default IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'multi_shared_socket default is %, expected true', v_default;
  END IF;

  SELECT count(*) INTO v_false_rows
    FROM public.user_table_settings
   WHERE multi_shared_socket = false;
  IF v_false_rows <> 0 THEN
    RAISE EXCEPTION '% rows still have multi_shared_socket=false', v_false_rows;
  END IF;
END $$;

-- ROLLBACK (Tier 2 courtesy):
--   ALTER TABLE public.user_table_settings
--     ALTER COLUMN multi_shared_socket SET DEFAULT false;
--   -- per-user values cannot be selectively restored; users re-toggle.
