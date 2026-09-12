CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
CREATE TABLE public.bbj_pools (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    club_id uuid,
    union_id uuid,
    pool_amount numeric(14,2) DEFAULT 0 NOT NULL,
    hands_contributed bigint DEFAULT 0,
    last_hit_at timestamp with time zone,
    last_hit_amount numeric(14,2) DEFAULT 0,
    last_winner_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    main_balance numeric(14,2) DEFAULT 0 NOT NULL,
    backup_balance numeric(14,2) DEFAULT 0 NOT NULL,
    promo_balance numeric(14,2) DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    total_contributed numeric DEFAULT 0,
    total_paid_out numeric(15,2) DEFAULT 0.00 NOT NULL,
    hit_count integer DEFAULT 0 NOT NULL,
    last_loser_id uuid,
    merged_into_pool_id uuid,
    alloc_cum_amount numeric(14,4) DEFAULT 0 NOT NULL,
    mini_reserve_floor numeric(14,2) DEFAULT 5000.00 NOT NULL,
    CONSTRAINT bbj_pools_backup_balance_nonneg CHECK ((backup_balance >= (0)::numeric)),
    CONSTRAINT bbj_pools_main_balance_nonneg CHECK ((main_balance >= (0)::numeric)),
    CONSTRAINT bbj_pools_promo_balance_nonneg CHECK ((promo_balance >= (0)::numeric)),
    CONSTRAINT chk_alloc_cum_amount_is_two_decimal_places CHECK (((alloc_cum_amount IS NULL) OR (alloc_cum_amount = round(alloc_cum_amount, 2))))
);
CREATE TABLE public.ca_bbj_bucket_moves (
    id bigint NOT NULL,
    pool_id uuid NOT NULL,
    from_bank text NOT NULL,
    to_bank text NOT NULL,
    amount numeric NOT NULL,
    reason text NOT NULL,
    op_id text NOT NULL,
    performed_by uuid,
    db_role text DEFAULT CURRENT_USER NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ca_bbj_bucket_moves_amount_check CHECK (((amount > (0)::numeric) AND (amount = round(amount, 2)))),
    CONSTRAINT ca_bbj_bucket_moves_check CHECK ((from_bank <> to_bank)),
    CONSTRAINT ca_bbj_bucket_moves_from_bank_check CHECK ((from_bank = ANY (ARRAY['main'::text, 'backup'::text, 'promo'::text]))),
    CONSTRAINT ca_bbj_bucket_moves_reason_check CHECK ((length(btrim(reason)) >= 10)),
    CONSTRAINT ca_bbj_bucket_moves_to_bank_check CHECK ((to_bank = ANY (ARRAY['main'::text, 'backup'::text, 'promo'::text]))),
    CONSTRAINT chk_amount_is_two_decimal_places CHECK (((amount IS NULL) OR (amount = round(amount, 2))))
);
CREATE SEQUENCE public.ca_bbj_bucket_moves_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.ca_bbj_bucket_moves_id_seq OWNED BY public.ca_bbj_bucket_moves.id;
ALTER TABLE ONLY public.ca_bbj_bucket_moves ALTER COLUMN id SET DEFAULT nextval('public.ca_bbj_bucket_moves_id_seq'::regclass);
ALTER TABLE ONLY public.bbj_pools
    ADD CONSTRAINT bbj_pools_club_id_key UNIQUE (club_id);
ALTER TABLE ONLY public.bbj_pools
    ADD CONSTRAINT bbj_pools_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ca_bbj_bucket_moves
    ADD CONSTRAINT ca_bbj_bucket_moves_op_id_key UNIQUE (op_id);
ALTER TABLE ONLY public.ca_bbj_bucket_moves
    ADD CONSTRAINT ca_bbj_bucket_moves_pkey PRIMARY KEY (id);
INSERT INTO public.bbj_pools(id,main_balance,backup_balance,promo_balance) VALUES
('00000000-0000-0000-0000-000000000001',0,10,0),('00000000-0000-0000-0000-000000000002',0,0,0);
INSERT INTO public.ca_bbj_bucket_moves(id,pool_id,from_bank,to_bank,amount,reason,op_id)
VALUES(1,'00000000-0000-0000-0000-000000000001','main','backup',10,'original accepted reason','replay-op');
CREATE FUNCTION public.replay_write_tripwire() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'REPLAY_WRITE_TRIPWIRE % %', TG_TABLE_NAME,TG_OP; END $$;
CREATE TRIGGER replay_tripwire BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.bbj_pools FOR EACH STATEMENT EXECUTE FUNCTION public.replay_write_tripwire();
CREATE TRIGGER replay_tripwire BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.ca_bbj_bucket_moves FOR EACH STATEMENT EXECUTE FUNCTION public.replay_write_tripwire();
CREATE FUNCTION public.fn_bbj_parked_reserve(uuid,text) RETURNS numeric LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'REPLAY_PATH_TRIPWIRE reserve'; END $$;
CREATE FUNCTION public.fn_ca_declare_ledger(text,text,uuid DEFAULT NULL,uuid DEFAULT NULL,text DEFAULT NULL,text[] DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'REPLAY_PATH_TRIPWIRE ledger'; END $$;
