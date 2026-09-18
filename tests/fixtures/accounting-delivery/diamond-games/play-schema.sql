-- Exact installed supplemental schema captured September 17; synthetic rows only.
CREATE TABLE public.plinko_tables (version integer NOT NULL, name text NOT NULL, board_rows smallint DEFAULT 16 NOT NULL, multipliers_cents integer[] NOT NULL, max_multiplier_cents integer NOT NULL, spec_rtp numeric(8,6), sd_chips numeric(10,6), hit_rate numeric(8,6), note text, created_at timestamp with time zone DEFAULT now() NOT NULL, activated_at timestamp with time zone);
ALTER TABLE public.plinko_tables ADD CONSTRAINT plinko_tables_board_rows_check CHECK ((board_rows = 16));
ALTER TABLE public.plinko_tables ADD CONSTRAINT plinko_tables_multipliers_cents_check CHECK ((array_length(multipliers_cents, 1) = 17));
ALTER TABLE public.plinko_tables ADD CONSTRAINT plinko_tables_pkey PRIMARY KEY (version);
CREATE TABLE public.diamond_spins_owner_consents (host_id uuid NOT NULL, owner_id uuid NOT NULL, host_kind text NOT NULL, terms_version text NOT NULL, accepted_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL, terms_text text NOT NULL);
ALTER TABLE public.diamond_spins_owner_consents ADD CONSTRAINT diamond_spins_owner_consents_host_kind_check CHECK ((host_kind = ANY (ARRAY['club'::text, 'union'::text])));
ALTER TABLE public.diamond_spins_owner_consents ADD CONSTRAINT diamond_spins_owner_consents_pkey PRIMARY KEY (host_id, owner_id, terms_version);

