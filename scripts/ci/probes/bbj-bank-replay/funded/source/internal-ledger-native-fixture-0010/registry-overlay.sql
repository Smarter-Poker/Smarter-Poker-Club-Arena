-- FUTURE PRIVATE FIXTURE ONLY. No financial helper/guard replacement.
DO $absent$ BEGIN
 IF to_regclass('public.ca_chip_store_coverage') IS NOT NULL THEN
  RAISE EXCEPTION 'Registry already exists before exact fixture overlay';
 END IF;
END $absent$;
CREATE TABLE IF NOT EXISTS public.ca_chip_store_coverage (
  store      text PRIMARY KEY,
  treatment  text NOT NULL CHECK (treatment IN ('counted','noncirculating','uncounted')),
  counted_by text,
  notes      text,
  added_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ca_chip_store_coverage IS
  'Every from_type/to_type the chip journal allows, and how the supply basis treats it. counted: inside fn_ca_supply_snapshot total, counted_by names the component. noncirculating: issuance or retirement, so a move across it is mint or burn. uncounted: known to be outside the basis, so any movement raises a finding rather than passing as drift. An undeclared store is refused at first use.';

ALTER TABLE public.ca_chip_store_coverage ENABLE ROW LEVEL SECURITY;

INSERT INTO public.ca_chip_store_coverage (store, treatment, counted_by, notes) VALUES
  ('player_wallet',       'counted', 'member_wallets + member_promo', 'club_members chip_balance and promo_balance'),
  ('club_treasury',       'counted', 'treasuries',                    'clubs chip_treasury'),
  ('union_bank',          'counted', 'union_wallets',                 'union_wallets chip_balance'),
  ('agent_wallet',        'counted', 'agent_wallets',                 'agents agent_wallet_balance and promo_wallet_balance'),
  ('table_stack',         'counted', 'felt',                          'table_seats stack on cash tables. Tournament felt is deliberately excluded and carried by tournament_liability instead'),
  ('promo_wallet',        'counted', 'club_promo + agent_promo + union promo_wallet', 'the promo floats, brought inside the total on 2026-09-03'),
  ('club_wallet',         'counted', 'club_wallets',                  'club_wallets chip_balance'),
  ('union_wallet',        'counted', 'union_wallets',                 'the union rake, bbj, promo, insurance and spin reserve wallets'),
  ('bbj_pool',            'counted', 'bbj_pools',                     'main, backup and promo'),
  ('spin_reserve',        'counted', 'spin_pools + union spin_reserve_wallet', 'spin_bonus_pools balance'),
  ('insurance_bank',      'counted', 'club_insurance + union insurance_wallet', 'clubs insurance_balance'),
  ('escrow',              'counted', 'ticket_escrow',                 'Outstanding tournament tickets. ADDED 2026-09-11: it was in no list at all, which is the whole of the five supply incidents of that morning'),
  ('prize_liability',     'counted', 'tournament_liability',          'tournament_escrow prize_balance, or the counters where an event has no escrow row yet'),
  ('bounty_liability',    'counted', 'tournament_liability',          'tournament_escrow bounty_balance'),
  ('opening_setup',       'counted', 'leaderboard_liability',         'club_opening_setups leaderboard_seed_remaining'),
  ('leaderboard_round',   'counted', 'leaderboard_liability',         'the same seed, while a round is being settled'),
  ('system_mint',         'noncirculating', NULL, 'issuance. A move out of it is a mint'),
  ('system_burn',         'noncirculating', NULL, 'retirement. A move into it is a burn'),
  ('issuance_reserve',    'noncirculating', NULL, 'issuance held before it enters circulation'),
  ('chip_retirement',     'noncirculating', NULL, 'retirement holding'),
  ('settlement_suspense', 'uncounted', NULL,
   'NOT in the basis and NOT verified as a routing label. It holds a large historical net and has not moved in the sixty hours to 2026-09-11 15:00, so it is not implicated in the incidents this migration fixes. Declared uncounted deliberately rather than guessed into the total, where a wrong guess would double count. Any movement now raises a finding, which is the point'),
  ('rakeback_payable',    'uncounted', NULL, 'never used in the journal to date. Movement raises a finding so its treatment is decided before it carries money'),
  ('refund_payable',      'uncounted', NULL, 'never used in the journal to date. Movement raises a finding so its treatment is decided before it carries money'),
  ('credit_facility',     'uncounted', NULL, 'never used in the journal to date. Movement raises a finding so its treatment is decided before it carries money'),
  ('credit_receivable',   'uncounted', NULL, 'never used in the journal to date. Movement raises a finding so its treatment is decided before it carries money')
ON CONFLICT (store) DO NOTHING;

ALTER TABLE public.ca_chip_store_coverage OWNER TO postgres;
-- Remove only this new owned table's inherited defaults before exact grants.
-- NULL and empty ACL arrays are not passed to aclexplode.
DO $acl$ DECLARE v_acl aclitem[]; r record; BEGIN
 SELECT relacl INTO v_acl FROM pg_class WHERE oid='public.ca_chip_store_coverage'::regclass;
 IF v_acl IS NOT NULL AND cardinality(v_acl)>0 THEN
  FOR r IN SELECT DISTINCT x.grantee FROM aclexplode(v_acl) x LOOP
   EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.ca_chip_store_coverage FROM ' ||
     CASE WHEN r.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(r.grantee)) END;
  END LOOP;
 END IF;
END $acl$;
REVOKE ALL PRIVILEGES ON TABLE public.ca_chip_store_coverage FROM PUBLIC;
GRANT SELECT ON TABLE public.ca_chip_store_coverage TO "anon";
GRANT TRIGGER ON TABLE public.ca_chip_store_coverage TO "anon";
GRANT REFERENCES ON TABLE public.ca_chip_store_coverage TO "anon";
GRANT SELECT ON TABLE public.ca_chip_store_coverage TO "authenticated";
GRANT TRIGGER ON TABLE public.ca_chip_store_coverage TO "authenticated";
GRANT REFERENCES ON TABLE public.ca_chip_store_coverage TO "authenticated";
GRANT TRUNCATE ON TABLE public.ca_chip_store_coverage TO "postgres";
GRANT INSERT ON TABLE public.ca_chip_store_coverage TO "postgres";
GRANT DELETE ON TABLE public.ca_chip_store_coverage TO "postgres";
GRANT MAINTAIN ON TABLE public.ca_chip_store_coverage TO "postgres";
GRANT SELECT ON TABLE public.ca_chip_store_coverage TO "postgres";
GRANT TRIGGER ON TABLE public.ca_chip_store_coverage TO "postgres";
GRANT UPDATE ON TABLE public.ca_chip_store_coverage TO "postgres";
GRANT REFERENCES ON TABLE public.ca_chip_store_coverage TO "postgres";
GRANT TRUNCATE ON TABLE public.ca_chip_store_coverage TO "service_role";
GRANT INSERT ON TABLE public.ca_chip_store_coverage TO "service_role";
GRANT DELETE ON TABLE public.ca_chip_store_coverage TO "service_role";
GRANT MAINTAIN ON TABLE public.ca_chip_store_coverage TO "service_role";
GRANT SELECT ON TABLE public.ca_chip_store_coverage TO "service_role";
GRANT TRIGGER ON TABLE public.ca_chip_store_coverage TO "service_role";
GRANT UPDATE ON TABLE public.ca_chip_store_coverage TO "service_role";
GRANT REFERENCES ON TABLE public.ca_chip_store_coverage TO "service_role";
