-- Exact read-only catalog capture: 2026-09-17T05:11:51.221262+00:00

-- Policy helper relation required while PostgreSQL validates fn_union_oversees_club.

-- No production rows are copied and this relation is not mutated by the probes.

CREATE TABLE public.union_clubs (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "union_id" uuid NOT NULL,
  "club_id" uuid NOT NULL,
  "joined_at" timestamp with time zone DEFAULT now(),
  "club_commission_rate" numeric(5,4) DEFAULT 0.9000,
  "rate_cash" numeric,
  "rate_mtt" numeric,
  "rate_sng" numeric,
  "rate_spin" numeric,
  "rate_satellite" numeric
);

ALTER TABLE public.union_clubs OWNER TO postgres;

ALTER TABLE public.union_clubs ADD CONSTRAINT "union_clubs_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;

ALTER TABLE public.union_clubs ADD CONSTRAINT "union_clubs_game_rates_are_fractions" CHECK ((rate_cash IS NULL OR rate_cash >= 0::numeric AND rate_cash <= 1::numeric) AND (rate_mtt IS NULL OR rate_mtt >= 0::numeric AND rate_mtt <= 1::numeric) AND (rate_sng IS NULL OR rate_sng >= 0::numeric AND rate_sng <= 1::numeric) AND (rate_spin IS NULL OR rate_spin >= 0::numeric AND rate_spin <= 1::numeric) AND (rate_satellite IS NULL OR rate_satellite >= 0::numeric AND rate_satellite <= 1::numeric));

ALTER TABLE public.union_clubs ADD CONSTRAINT "union_clubs_pkey" PRIMARY KEY (id);

ALTER TABLE public.union_clubs ADD CONSTRAINT "union_clubs_union_id_club_id_key" UNIQUE (union_id, club_id);

ALTER TABLE public.union_clubs ADD CONSTRAINT "union_clubs_union_id_fkey" FOREIGN KEY (union_id) REFERENCES unions(id) ON DELETE CASCADE;

CREATE INDEX idx_union_clubs_club_id ON public.union_clubs USING btree (club_id);

REVOKE ALL ON TABLE public.union_clubs FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.union_clubs TO "postgres";

GRANT INSERT, SELECT, UPDATE, DELETE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.union_clubs TO "anon";

GRANT INSERT, SELECT, UPDATE, DELETE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.union_clubs TO "authenticated";

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.union_clubs TO "service_role";

ALTER TABLE public.union_clubs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "union_clubs_read" ON public.union_clubs AS PERMISSIVE FOR SELECT TO PUBLIC USING (((EXISTS ( SELECT 1
   FROM union_admins ua
  WHERE ((ua.union_id = union_clubs.union_id) AND (ua.user_id = ( SELECT auth.uid() AS uid))))) OR (EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = union_clubs.club_id) AND (c.owner_id = ( SELECT auth.uid() AS uid))))) OR (EXISTS ( SELECT 1
   FROM club_members cm
  WHERE ((cm.club_id = union_clubs.club_id) AND (cm.user_id = ( SELECT auth.uid() AS uid)))))));

CREATE POLICY "union_clubs_svc" ON public.union_clubs AS PERMISSIVE FOR ALL TO "service_role" USING (true);

DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_attribute WHERE attrelid='public.union_clubs'::regclass AND attnum>0 AND NOT attisdropped)<>10 OR (SELECT count(*) FROM pg_constraint WHERE conrelid='public.union_clubs'::regclass)<>5 OR (SELECT count(*) FROM pg_index WHERE indrelid='public.union_clubs'::regclass)<>3 OR (SELECT count(*) FROM pg_policy WHERE polrelid='public.union_clubs'::regclass)<>2 THEN RAISE EXCEPTION 'Diamond union_clubs metadata witness failed'; END IF; END $fixture$;
