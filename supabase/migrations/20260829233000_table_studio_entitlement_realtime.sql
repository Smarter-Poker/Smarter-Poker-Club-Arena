-- TABLE STUDIO ENTITLEMENTS — CROSS-DEVICE REALTIME
--
-- MasterBus makes a completed checkout visible to every open tab in one
-- browser. The durable ledger must also notify an already-open Table Studio on
-- another device. RLS continues to limit rows to the authenticated owner.

BEGIN;

ALTER TABLE public.theme_asset_unlocks REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1
         FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'theme_asset_unlocks'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.theme_asset_unlocks;
  END IF;
END $$;

COMMIT;
