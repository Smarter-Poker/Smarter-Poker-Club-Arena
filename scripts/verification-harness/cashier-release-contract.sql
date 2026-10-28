\set ON_ERROR_STOP on

-- Read-only post-deploy canary. It verifies the contracts the browser depends
-- on, not merely that similarly named objects exist.
BEGIN;
SET TRANSACTION READ ONLY;

DO $cashier_contract$
DECLARE
  v_contract jsonb;
  v_item jsonb;
  v_oid oid;
  v_actual_hash text;
  v_missing text;
  v_request_source text;
  v_telemetry_source text;
  v_telemetry_oid oid;
  v_private_contract jsonb;
  v_actual_owner text;
  v_security_definer boolean;
  v_search_path_pinned boolean;
  v_columns text[];
BEGIN
  SELECT string_agg(required.version, ', ' ORDER BY required.version)
  INTO v_missing
  FROM (
    VALUES
      ('20260830235990'),
      ('20260831235990'),
      ('20260831235991'),
      ('20260831235992'),
      ('20260906093024'),
      ('20260923150831'),
      ('20261004124327'),
      ('20261006022835')
  ) AS required(version)
  WHERE NOT EXISTS (
    SELECT 1
    FROM supabase_migrations.schema_migrations applied
    WHERE applied.version = required.version
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'cashier migration versions missing: %', v_missing;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
     WHERE version = '20261004124327'
       AND name = 'cashier_authority_and_retry_keys_are_exact'
  ) THEN
    RAISE EXCEPTION 'cashier authority migration history name drift';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
     WHERE version = '20261006022835'
       AND name = 'a_chip_request_tells_its_approver'
  ) THEN
    RAISE EXCEPTION 'cashier request-notification migration history name drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
     WHERE version = '20261017001657'
       AND name = 'a_deleted_account_leaves_every_club_and_every_list'
  ) THEN
    RAISE EXCEPTION 'cashier deleted-account directory migration history drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = to_regprocedure('public.fn_cashier_recovery_receipts(uuid,uuid[],text[])')
       AND pg_get_userbyid(proowner) = 'postgres' AND provolatile = 's'
  ) THEN
    RAISE EXCEPTION 'cashier original receipt recovery posture drift';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_cashier_conservation_report(uuid)') AND pg_get_userbyid(proowner)='postgres' AND provolatile='s') THEN
    RAISE EXCEPTION 'cashier accounting report posture drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
     WHERE version = '20261019185853'
       AND name = 'new_clubs_reconcile_player_wallets_from_their_journal_origin'
  ) THEN
    RAISE EXCEPTION 'cashier conservation origin migration history drift';
  END IF;

  -- The destination-aware reclaim and movement-only history are one installed
  -- contract; the later self-claim exception is its only accepted successor.
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
     WHERE version = '20261027160320'
       AND name = 'cashier_claim_destination_and_movement_history'
  ) OR NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
     WHERE version = '20261027164937'
       AND name = 'agents_reclaim_from_their_own_wallets_at_any_time'
  ) THEN
    RAISE EXCEPTION 'cashier reclaim and movement history migration history drift';
  END IF;

  v_contract := jsonb_build_array(
    jsonb_build_object(
      'signature', 'public.fn_club_wallet_claim_back(uuid,uuid,numeric,text,text,text,uuid,uuid)',
      -- Qualified 160320 destination/credit/replay body with only the 164937
      -- actor=holder exception; all three agent tiers passed native proof.
      'hash', '54450c4c6f5e6ca4d3b7804a669bf0cc',
      'owner', 'postgres'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_history_feed(uuid,text,text,timestamp with time zone,timestamp with time zone,uuid,text,timestamp with time zone,uuid,integer)',
      -- Installed 160320: server-scoped chip movements, including paging/export.
      'hash', 'dad4d92ef739f520d0c512c9950d5c62',
      'owner', 'postgres'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_history_summary(uuid,text,text,timestamp with time zone,timestamp with time zone,uuid)',
      'hash', 'cf02a67ac0d71d5e0db7c84a5b224f23',
      'owner', 'postgres'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_conservation_report(uuid)',
      -- Installed 20261019185853 retains the sealed-day and bank-entity
      -- contracts and reconciles new-club wallets from their journal origin.
      -- scripts/ci/test-new-club-conservation-origin-postgres.py qualifies
      -- the exact installed definition, legacy equivalence and refusals.
      -- Retired predecessors and unknown definitions must fail closed.
      'hash', '617a6a58c41f8a1f204e3438d6ea2a4c'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_recovery_receipts(uuid,uuid[],text[])',
      'hash', 'c4cf363fde8d283e3163baf5391ce87e'
    ),
    jsonb_build_object(
      'signature', 'public.fn_agent_wallet_claim_back(uuid,uuid,numeric,text,uuid)',
      'hash', '85976e86092390fb1950b8ed31c36c0d'
    ),
    jsonb_build_object(
      'signature', 'public.fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid)',
      -- The launch hardening wrapper claims the global exact-intent lock before
      -- entering the retained agreement, hierarchy and money-row lock order.
      'hash', 'c6c14eb18feb9a645a7aa2ffad3cf6f1'
    ),
    jsonb_build_object(
      'signature', 'public.fn_request_chips(uuid,numeric,text,uuid)',
      'hash', '1ec88991eae29ca25812490c742ae906'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_batch_transfer(uuid,text,jsonb,uuid)',
      -- Installed 20261016024912 binds the explicitly selected source and
      -- destination wallets. Qualified full definition read back live.
      'hash', '859bb844228d65085bf134c4dbd8b32b'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_cashier_members_page_v3(uuid,integer,uuid,integer)',
      -- Re-pinned 2026-09-03. The body changed for a REASON, not by drift:
      -- 20260903035252 wrapped the flag as
      --   (public.fn_can_see_horse_flag(p_club_id) AND COALESCE(m.is_horse,false))
      -- because v2 masked the horse flag and this paged v3, written after it,
      -- did not - so the same data leaked through the newer door to anyone
      -- ca_can_view_club_finances admits, SUPER_AGENT included.
      -- The migration was applied to production but never committed, so this
      -- pin was left naming a body that no longer existed and Post-Deploy E2E
      -- failed on it every run. The migration is committed alongside this.
      -- Every OTHER hash in this file was re-checked against production at the
      -- same time and all five still match.
      'hash', '69233cd46670fbc2989173f6ba9f4328'
    ),
    jsonb_build_object(
      'signature', 'public.fn_issue_tournament_ticket(uuid,uuid,numeric,text,text)',
      'hash', 'a8a8a18f4ee84e0b2e147ebdc380e5d1'
    ),
    -- Active Cashier authority and globally exact retry keys.
    -- 20261021183705 made the raw hierarchy predicates private. Browsers and
    -- RLS reach them only through these caller-bound wrappers.
    jsonb_build_object(
      'signature', 'public.fn_club_viewer_cashier_scope(uuid)',
      'hash', 'eeccecf423aec1a64eb320b7cb5fd477'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_viewer_can_transact(uuid,uuid)',
      'hash', '4aae2a2d5d0a3c13b2f9d6b6eac9f711'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_cashier_members(uuid)',
      'hash', '052a7ade475196368af0e465417f23eb',
      -- 20261021172828 lets an agent fund their own player wallet; its exact
      -- committed definition is the only accepted successor.
      'replacement_hash', '946866fcc1e0dc2e402acb514dfe86f6'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_trade_ledger(uuid,integer,integer)',
      -- Pin the full pg_get_functiondef fingerprint. The first launch repair
      -- accidentally copied md5(prosrc) from the native source-binding row;
      -- the post-deploy canary intentionally compares the third field, the
      -- complete callable definition including result shape and posture.
      -- 20261010005048 names both sides with fn_arena_name instead of the
      -- World Hub display name first. 20261012040542 (installed and read back
      -- live 2026-10-12) prints a treasury-funded seat as the Club Bank send
      -- it is and names a send's operator only to the operator and the member
      -- paid; same rows, same posture.
      'hash', '1b1312459ecc90069375d8bcdb3127ca',
      -- 20261020210238 (installed 20261021174527) restricts agent bank reads.
      'replacement_hash', 'dd389f9dd3013aef5e50bbd456291297'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_transaction_history(uuid,text,integer,integer)',
      -- The Cashier's Transaction History door (Dan 2026-10-24). Migration
      -- 20261024203917, installed and recorded under that version; full definition
      -- read back live the same day as owner, agent and player.
      'hash', '3919f3ef7a21ed33e2f0c7a80113c7d2'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_history_page(uuid,text,text,timestamp with time zone,timestamp with time zone,integer,integer)',
      -- Transaction History filters, date range and the agent's downline book
      -- (Dan 2026-10-24). Migration 20261024213601, installed through Apply
      -- Merged Migration and recorded under that version; read back live.
      'hash', '25db80241e3b8e5823b7335631b6a18f'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_history_totals(uuid,text,timestamp with time zone,timestamp with time zone)',
      -- The viewer's own In, Out and Net over the filtered book (same migration).
      'hash', '52ae19055464aa6525a02a04ce7fdec0'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_bank_send(uuid,uuid,numeric,text,text,uuid)',
      -- Installed 20261016021637 takes the agreement mutex before the retained
      -- bank core. Exact full definition and owner/ACL posture read back live.
      'hash', '08e0c75b5fb1f51fc8c31a8928271fb6'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_bank_claim_back(uuid,uuid,numeric,text,text,uuid)',
      'hash', 'a5849400f773e9ea87713e028bf9da1f'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_bank_reverse(uuid,text,uuid)',
      'hash', '57316a8063bd10da0c74dc3cbba4a5c4'
    ),
    jsonb_build_object(
      'signature', 'public.fn_admin_remove_player_chips(uuid,uuid,numeric,text,uuid)',
      'hash', 'cbbd3827fc223013334d6e3aea86262b'
    ),
    jsonb_build_object(
      'signature', 'public.fn_promo_wallet_send(uuid,uuid,numeric,text,text,uuid)',
      'hash', '3ca226aa6fa735dd123c68ceaa98dda3'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_promo_wallet_send(uuid,uuid,numeric,text,text,uuid)',
      'hash', 'b616cd82da2a682fcdf8b8b366872eda'
    ),
    -- Phase 5 cross-wallet statement doors, recorded version 20260923150831
    -- (file 20260923131325_cashier_statements_read_every_wallet_in_one_keyset).
    -- The private row query fn_cashier_statement_rows is not listed: this loop
    -- requires browser EXECUTE, which that owner-only helper must never have.
    -- Its body is pinned by md5 in the migrations that replace it (live since
    -- 2026-10-12: 20261012030847, the statement counts each move once,
    -- 8cab96c15ba360fb34c13f0afd3378b8; before it 20261011225840, #6688,
    -- b1f42803af9196e322159660ff6f9e57), and the doors below, which call it,
    -- are unchanged by both.
    jsonb_build_object(
      'signature', 'public.fn_cashier_statement_scope(uuid)',
      'hash', 'c8137ef74e0e7ccfb05b94697b3fb122',
      -- 20261020210238 (installed 20261021174527) restricts agent bank reads.
      'replacement_hash', 'e5b3fd28e1192dbe2e8e4b4f0ce56c79'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_statement_page(uuid,timestamptz,timestamptz,jsonb,jsonb,integer)',
      'hash', '06493bb58a2199b8aaed0f950bafe2c2'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_statement_totals(uuid,timestamptz,timestamptz,jsonb)',
      'hash', '5e50033127ded658f0bb4de87e0a10e6'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_statement_export_start(uuid,timestamptz,timestamptz,jsonb,uuid)',
      'hash', '64d8ce9fac09f83bb04105cded1e6177'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_statement_export_page(uuid,integer,integer)',
      'hash', '3ab1d903bbd15f1b8c97e6bc168bc466'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashier_statement_export_cancel(uuid)',
      'hash', '7772e8238e42f490c20e2235d1358ce2'
    ),
    -- Launch audit 2026-10-09 (findings S-02 and S-12). Every remaining RPC the
    -- browser calls from a cashier surface, pinned to the production body read
    -- the same day (md5(pg_get_functiondef), project kuklfnapbkmacvwxktbh,
    -- $HOME/tmp-claude/audit1009/production-rpc-hashes-20261009.txt). Entries
    -- whose production proconfig pins a search_path other than
    -- 'public, pg_temp' say so with 'search_path'; the loop below checks the
    -- exact installed value, never a weaker one.
    --
    -- The cashout v2 family is DEFINED ONLY in
    -- supabase/accounting/weekly-v3/components/20260914164700_cashier_cashout_documents_share_the_existing_invoice_authority.sql
    -- (installed on production 2026-09-14; the legacy fn_cashout_request /
    -- approve / release were retired to 'cashier_v2_intent_required' tombstones
    -- the same day). By decision the migrations directory holds no mirror of
    -- it, so this pin is the only repo-side proof the live writers are the
    -- audited bodies.
    jsonb_build_object(
      'signature', 'public.fn_cashout_request_v2(uuid,numeric,uuid,uuid,text)',
      'hash', '07cf5457edf315929b07316c07be313d'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashout_approve_v2(uuid,uuid,numeric,uuid,uuid,text)',
      'hash', '6fecd34df575557d81966dc1166a2fc4'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashout_release_v2(uuid,uuid,numeric,uuid,uuid,text)',
      'hash', '3122994e23d96770a2f50e4fe6a191a6'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cashout_queue(uuid,text)',
      'hash', 'a9e4ff8df86c6c83001000130e6b3827'
    ),
    jsonb_build_object(
      'signature', 'public.fn_agent_wallet_reversible(uuid)',
      -- 20261010005048 (installed and read back live 2026-10-12) names the
      -- recipient with fn_arena_name, not the World Hub display name first;
      -- same rows, same posture.
      'hash', '3cc86bbb6317359a7b43fc34524d5876'
    ),
    jsonb_build_object(
      'signature', 'public.fn_agent_wallet_self_stake(uuid,numeric,text,uuid)',
      'hash', '438f699e38c8e2e6a9949c76e526731b'
    ),
    jsonb_build_object(
      'signature', 'public.fn_respond_chip_request(uuid,text)',
      -- 20261010003544 keys an approval's send by request AND approver, so an
      -- approver who was refused (an agent with no float) no longer leaves the
      -- request unapprovable by anybody else. Installed and read back live
      -- 2026-10-12.
      'hash', '10fb3a12f5113521a2366a98af90ecbd'
    ),
    jsonb_build_object(
      'signature', 'public.fn_redeem_tournament_ticket(uuid)',
      -- 20261015132042: a cashier ticket bound to one tournament is refused
      -- here (it is used by registering). Same provenance as the batch hash.
      'hash', 'ab95c0907acccdedef0190acf242c8a3',
      'replacement_hash', '0bb17681b38164a7a2746e17d07597b3'
    ),
    jsonb_build_object(
      'signature', 'public.fn_cancel_tournament_ticket(uuid)',
      'hash', 'd3f65b7702d4b7f543891dd87c149353'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_bank_ledger(uuid,integer,integer,text[])',
      -- Its live body is the 20260903121500 DO-block rewrite pinned by md5 in
      -- 20261006005823, not the last CREATE (20260823170000).
      -- 20261012040542 (installed and read back live 2026-10-12) lists,
      -- filters and counts a treasury-funded seat as a Club Bank send.
      -- 20261016155801 (#7115, installed 2026-10-16) reads the same rows and
      -- totals in one pass; its transaction asserts this post-image.
      'hash', 'cb7edf507b92e7c22535d6fed10a416b'
    ),
    jsonb_build_object(
      'signature', 'public.fn_promo_wallet_ledger(text,uuid,integer,integer,text)',
      'hash', 'edbce76de5a1f9ba633d0a55e713ca00'
    ),
    jsonb_build_object(
      'signature', 'public.fn_my_wallet_ledger(uuid,integer,integer)',
      'hash', '59c419c559309605fcb3e2634beb830e'
    ),
    jsonb_build_object(
      'signature', 'public.fn_ca_chip_statement_page(text,uuid,jsonb,integer)',
      -- 20261012040542 (installed and read back live 2026-10-12) prints a
      -- funded seat's treasury leg as table funding with no description.
      'hash', 'd513f6f312b29835cc5e74aa8ff00ce0',
      'search_path', 'search_path=public'
    ),
    jsonb_build_object(
      'signature', 'public.fn_club_money_panel(uuid)',
      -- The installed 20261012181905 launch boundary adds only the scoped
      -- accounting-start read; the retained Club Bank/member/union gates are exact.
      'hash', 'f6b49d2e875e162c086f2186bfc60407',
      -- 20261020210238 (installed 20261021174527) restricts agent bank reads.
      'replacement_hash', 'a9cfc2f7f908666f5129743bb3fb44c2',
      'search_path', 'search_path=public, extensions'
    ),
    jsonb_build_object(
      'signature', 'public.fn_mint_chips_from_diamonds(uuid,numeric,uuid)',
      'hash', 'd6e453042dd2591855dd796adeae58c5'
    ),
    jsonb_build_object(
      'signature', 'public.fn_promo_disburse(text,uuid,text,uuid,numeric,text,uuid,uuid)',
      -- Installed 20261016132743 (#7104, Midway weekly horse promo): the
      -- engine/cron caller reads fn_caller_is_engine(), a union's own club
      -- members are eligible, and the union promo leg journals its own
      -- labelled ledger row. Owner checks for signed-in callers are unchanged.
      -- Full definition derived from the merged migration and read back live
      -- by post-deploy run 38929938237.
      'hash', 'e54e4f3949335c61d4c1492d81b5ca21',
      'search_path', 'search_path=public'
    ),
    jsonb_build_object(
      'signature', 'public.fn_player_spendable_balance(uuid,uuid,uuid,uuid)',
      -- Installed buy-in resolver 20261012131301: explicit club-only cashier
      -- reads and authority are unchanged; table/entry previews follow the debit.
      -- Exact source body 3dbf828a2c68ac402367aba5417bc45c was read back live.
      'hash', '2eef81f95feb167a6d687dbb538f9bc2',
      'replacement_hash', '7486d37ebaec9159719da58cdf8993ff',
      'search_path', 'search_path=public'
    ),
    jsonb_build_object(
      'signature', 'public.fn_union_send_to_member(uuid,uuid,text,numeric,text,text,text)',
      'hash', '4758d36acff34f922bf1129ae6eecc1d'
    ),
    jsonb_build_object(
      'signature', 'public.fn_union_player_directory(uuid)',
      -- Installed history 20261017001657 applies the reserved 20261016224731
      -- deleted-account filter. Removing that exact predicate from the full
      -- live definition reproduces the former d7cae706425a055f9039ba2b9535da48
      -- preimage. Only the qualified filtered directory is accepted now.
      'hash', 'fc06a6bf8f02822da43f6f4b4fe76385',
      'search_path', 'search_path=public'
    ),
    jsonb_build_object(
      'signature', 'public.fn_union_clawback_from_club(uuid,uuid,numeric,text,uuid)',
      'hash', 'f7bcdc0eab243e9372d28a3aab5f80b6',
      'search_path', 'search_path=public'
    ),
    jsonb_build_object(
      'signature', 'public.fn_union_clawback_promo_from_club(uuid,uuid,numeric,text,uuid)',
      'hash', 'd3019113da444c545a7b4475b700ad99'
    ),
    jsonb_build_object(
      'signature', 'public.fn_diamond_spin_statements(date)',
      'hash', '00971f8d29f0078bce0f8d63ac503a71'
    ),
    -- The last two client-called cashier doors. Production granted EXECUTE on
    -- them to authenticated and postgres only (read 2026-10-09), so this loop's
    -- ACL rule could not pin them; migration
    -- 20261010022852_cashier_contract_pins_need_service_role_execute grants
    -- service_role EXECUTE and nothing else. Hashes are the production bodies
    -- read 2026-10-09 (same file as the entries above).
    jsonb_build_object(
      'signature', 'public.fn_cashout_operation_receipt_v2(uuid,uuid,text,uuid,numeric,uuid,text)',
      -- The cashout v2 receipt reader (CashoutService).
      -- Its proconfig also carries lock_timeout=3s and statement_timeout=30s;
      -- the pin is the search_path element, checked by array containment.
      'hash', 'c9af51f246a9be79c7b79c49b760e9a9',
      'search_path', 'search_path=public'
    ),
    jsonb_build_object(
      'signature', 'public.send_wallet_diamond_transfer(uuid,integer,text,text)',
      -- The Diamond Wallet transfer (DiamondWalletTransfer).
      -- 20261010220349 adds the deletion refusal after immutable receipt replay.
      -- Exact isolated PostgreSQL writer qualification retains both journal legs.
      'hash', '655fd3a4fc415ef0032bb8799ee9e842'
    )
  );

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_contract)
  LOOP
    v_oid := to_regprocedure(v_item ->> 'signature');
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'cashier function missing: %', v_item ->> 'signature';
    END IF;
    SELECT md5(pg_get_functiondef(v_oid)) INTO v_actual_hash;
    IF v_actual_hash <> v_item ->> 'hash'
       AND v_actual_hash <> coalesce(v_item ->> 'replacement_hash', '') THEN
      RAISE EXCEPTION 'cashier function drift: % expected %, got %',
        v_item ->> 'signature',
        CASE
          WHEN v_item ? 'replacement_hash'
            THEN concat(v_item ->> 'hash', ' or ', v_item ->> 'replacement_hash')
          ELSE v_item ->> 'hash'
        END,
        v_actual_hash;
    END IF;
    IF v_item ? 'owner'
       AND (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = v_oid)
           IS DISTINCT FROM v_item ->> 'owner' THEN
      RAISE EXCEPTION 'cashier function owner drift: %', v_item ->> 'signature';
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
      RAISE EXCEPTION 'cashier function is not SECURITY DEFINER: %', v_item ->> 'signature';
    END IF;
    -- 'search_path=public, pg_temp' unless the entry pins the exact installed
    -- value it was read with; a pin is never satisfied by an unpinned function.
    IF NOT coalesce((SELECT proconfig @> ARRAY[
                       coalesce(v_item ->> 'search_path', 'search_path=public, pg_temp')
                     ]
                     FROM pg_proc WHERE oid = v_oid), false) THEN
      RAISE EXCEPTION 'cashier function search_path is not pinned: %', v_item ->> 'signature';
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'cashier function ACL drift: %', v_item ->> 'signature';
    END IF;
  END LOOP;

  -- Private helpers are source-pinned separately because they must not satisfy
  -- the browser EXECUTE contract above. Only the two pure read helpers remain
  -- callable by service_role; every mutating/actor primitive is owner-only.
  -- Active-member source includes the installed 20261010190307 deleted-profile rule.
  v_private_contract := jsonb_build_array(
    jsonb_build_object('signature', 'public.fn_cashier_member_is_active(uuid,uuid)',
      'hash', 'e2fa92deff49c93f0c68b5deff48aa1f', 'service_execute', true),
    jsonb_build_object('signature', 'public.fn_club_active_cashier_edges(uuid)',
      'hash', '7811cf9a95d7bc76037158c1285d4069', 'service_execute', true),
    -- Raw hierarchy predicates, private since 20261021183705; the caller-bound
    -- fn_club_viewer_* wrappers carry the browser and RLS contract instead.
    jsonb_build_object('signature', 'public.fn_club_bank_role(uuid,uuid)',
      'hash', 'a09db9468ed6160ddcc88c53d55f7c4a', 'service_execute', true),
    jsonb_build_object('signature', 'public.fn_club_is_in_downline(uuid,uuid,uuid)',
      'hash', 'bcfebe3728495bbe67afb93289137c36', 'service_execute', true),
    jsonb_build_object('signature', 'public.fn_club_cashier_can_transact(uuid,uuid,uuid)',
      'hash', 'a0cc4f8ffcd889e40a27053c60630f74', 'service_execute', true),
    jsonb_build_object('signature', 'public.fn_cashier_assert_active_actor(uuid)',
      'hash', 'fa89e518a9b123a7f3108a664f3a18dc', 'service_execute', false),
    jsonb_build_object('signature', 'public.fn_cashier_agent_status_mutex()',
      'hash', '5dee0639a212697d55abd89d9222ca9c', 'service_execute', false),
    jsonb_build_object('signature', 'public.fn_cashier_balance_actor_guard()',
      'hash', 'c40945eaa2dc22f9c12cf41a41583982', 'service_execute', false),
    jsonb_build_object('signature', 'public.fn_cashier_operation_mutex_guard()',
      'hash', '57750a582bad567907f62a2460cfc8c1', 'service_execute', false),
    jsonb_build_object('signature', 'public.fn_cashier_operation_intent_guard()',
      'hash', '4441e55c7f8b750b93b513c6e18f3f24', 'service_execute', false),
    jsonb_build_object('signature', 'public.fn_cashier_exact_intent_begin(text,uuid,uuid,jsonb)',
      -- 20261012181905 preserves completed receipts and refuses unfinished
      -- requests outside their original launch accounting boundary.
      'hash', '424fc2b2ee2ec319ecbbb7f267515f27', 'service_execute', false),
    jsonb_build_object('signature', 'public.fn_cashier_exact_intent_finish(uuid,jsonb)',
      'hash', 'cc05789c598b9b889a04f726b9b1e2ea', 'service_execute', false),
    jsonb_build_object('signature', 'public.fn_cashier_statement_downline(uuid,uuid)',
      'hash', 'bf72f0b13f26bf93b6a12aae579aa7d3', 'service_execute', false)
  );
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_private_contract)
  LOOP
    v_oid := to_regprocedure(v_item ->> 'signature');
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'private cashier function missing: %', v_item ->> 'signature';
    END IF;
    SELECT md5(prosrc) INTO v_actual_hash FROM pg_proc WHERE oid = v_oid;
    IF v_actual_hash <> v_item ->> 'hash' THEN
      RAISE EXCEPTION 'private cashier function drift: % expected %, got %',
        v_item ->> 'signature', v_item ->> 'hash', v_actual_hash;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('service_role', v_oid, 'EXECUTE')
          <> (v_item ->> 'service_execute')::boolean THEN
      RAISE EXCEPTION 'private cashier function ACL drift: %', v_item ->> 'signature';
    END IF;
  END LOOP;

  -- Renaming keeps the audited production bodies intact. Certify each private
  -- core by exact source, owner, definer/search-path posture and denied caller
  -- ACLs so a same-name replacement cannot hide behind the public wrapper.
  -- Bank and club-promo cores re-pinned to the installed 20261021174527 bodies.
  v_private_contract := jsonb_build_array(
    jsonb_build_object('signature', 'public.fn_club_bank_send_core_20261004(uuid,uuid,numeric,text,text,uuid)',
      'hash', '0b7684873b6cee74e2eafb2cf9cf604a'),
    jsonb_build_object('signature', 'public.fn_club_bank_claim_core_20261004(uuid,uuid,numeric,text,text,uuid)',
      -- Installed 160320 keeps promo claims in club promo and records that
      -- destination's balance. Native proof and live source agree exactly.
      'hash', 'fcfeeb86ff63e1a4e4c01315d851a1e8'),
    jsonb_build_object('signature', 'public.fn_club_bank_reverse_core_20261004(uuid,text,uuid)',
      'hash', '2a67b4b80c857356ef0eaca621b358c3'),
    jsonb_build_object('signature', 'public.fn_admin_remove_chips_core_20261004(uuid,uuid,numeric,text,uuid)',
      'hash', 'ac293c1623da0db62d74f5e888c1011a'),
    jsonb_build_object('signature', 'public.fn_promo_wallet_send_core_20261004(uuid,uuid,numeric,text,text,uuid)',
      'hash', 'b6b0c7686b67d33e2b01c132f8775cbc'),
    jsonb_build_object('signature', 'public.fn_club_promo_send_core_20261004(uuid,uuid,numeric,text,text,uuid)',
      'hash', 'e2fa848a65ab3615117385fc0614c229'),
    jsonb_build_object('signature', 'public.fn_agent_wallet_send_core_20261004(uuid,uuid,numeric,text,text,uuid)',
      'hash', '7a357ba95a8ca4eb13f00f798233d8d4'),
    jsonb_build_object('signature', 'public.fn_agent_wallet_claim_back_core_20261004(uuid,uuid,numeric,text,uuid)',
      'hash', 'cf7af5fd327c68c935a58e864537cc7a'),
    jsonb_build_object('signature', 'public.fn_request_chips_core_20261004(uuid,numeric,text,uuid)',
      -- 20261006022835 injects the approver notification into the retained
      -- private core. Pin that installed post-image, not its pre-notification
      -- body from 20260906093024.
      'hash', '1dce6c06306523ba83060f1546611648')
  );
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_private_contract)
  LOOP
    v_oid := to_regprocedure(v_item ->> 'signature');
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'private cashier core missing: %', v_item ->> 'signature';
    END IF;
    SELECT md5(prosrc), pg_get_userbyid(proowner), prosecdef,
           coalesce(proconfig @> ARRAY['search_path=public, pg_temp'], false)
      INTO v_actual_hash, v_actual_owner, v_security_definer, v_search_path_pinned
      FROM pg_proc WHERE oid = v_oid;
    IF v_actual_hash IS DISTINCT FROM v_item ->> 'hash'
       OR v_actual_owner IS DISTINCT FROM 'postgres'
       OR v_security_definer IS DISTINCT FROM true
       OR v_search_path_pinned IS DISTINCT FROM true
       OR has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION
        'private cashier core contract drift: % hash=% owner=% definer=% pinned=%',
        v_item ->> 'signature', v_actual_hash, v_actual_owner,
        v_security_definer, v_search_path_pinned;
    END IF;
  END LOOP;

  IF to_regclass('public.cashier_rpc_operation_intents') IS NULL
     OR NOT (SELECT relrowsecurity FROM pg_class
              WHERE oid = 'public.cashier_rpc_operation_intents'::regclass)
     OR has_table_privilege('anon', 'public.cashier_rpc_operation_intents', 'SELECT')
     OR has_table_privilege('authenticated', 'public.cashier_rpc_operation_intents', 'SELECT')
     OR has_table_privilege('authenticated', 'public.cashier_rpc_operation_intents', 'INSERT')
     OR has_table_privilege('authenticated', 'public.cashier_rpc_operation_intents', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.cashier_rpc_operation_intents', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.cashier_rpc_operation_intents', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.cashier_rpc_operation_intents', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.cashier_rpc_operation_intents', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.cashier_rpc_operation_intents', 'DELETE') THEN
    RAISE EXCEPTION 'cashier exact-intent table RLS/ACL drift';
  END IF;
  SELECT array_agg(attname::text ORDER BY attnum) INTO v_columns
    FROM pg_attribute
   WHERE attrelid = 'public.cashier_rpc_operation_intents'::regclass
     AND attnum > 0 AND NOT attisdropped;
  IF v_columns IS DISTINCT FROM ARRAY[
    'operation_id','actor_user_id','action','club_id','operation_intent',
    'intent_fingerprint','receipt','created_at','completed_at'
  ]::text[] THEN
    RAISE EXCEPTION 'cashier exact-intent table columns drift: %', v_columns;
  END IF;

  IF (SELECT count(*) FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND t.tgenabled <> 'D'
        AND p.proname = 'fn_cashier_balance_actor_guard'
        AND (c.relname, t.tgname) IN (
          ('clubs', 'cashier_club_balance_actor_guard'),
          ('club_members', 'cashier_member_balance_actor_guard'),
          ('agents', 'cashier_agent_balance_actor_guard')
        )) <> 3 THEN
    RAISE EXCEPTION 'cashier active-actor balance trigger drift';
  END IF;

  IF (SELECT count(*) FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND t.tgenabled <> 'D'
        AND (
          (p.proname = 'fn_cashier_operation_mutex_guard' AND
            (c.relname, t.tgname) IN (
              ('clubs', 'cashier_club_operation_mutex'),
              ('club_members', 'cashier_member_operation_mutex'),
              ('agents', 'cashier_agent_operation_mutex')
            ))
          OR (p.proname = 'fn_cashier_agent_status_mutex' AND
            (c.relname, t.tgname) IN (
              ('agents', 'cashier_agent_status_mutex_update'),
              ('agents', 'cashier_agent_status_mutex_delete')
            ))
          OR (p.proname = 'fn_cashier_operation_intent_guard'
              AND c.relname = 'chip_transactions'
              AND t.tgname = 'cashier_operation_intent_guard')
        )) <> 6 THEN
    RAISE EXCEPTION 'cashier authority/retry serialization trigger drift';
  END IF;

  IF (SELECT count(*) FROM public.ca_declared_money_triggers d
      WHERE (d.table_name, d.trigger_name) IN (
        ('club_members', 'cashier_member_balance_actor_guard'),
        ('club_members', 'cashier_member_operation_mutex')
      )) <> 2 THEN
    RAISE EXCEPTION 'cashier club_members money-trigger declarations missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'club_members'
      AND policyname = 'cashier_downline_read' AND cmd = 'SELECT'
      AND roles @> ARRAY['authenticated']::name[]
      AND qual LIKE '%fn_club_viewer_can_transact(%'
  ) THEN
    RAISE EXCEPTION 'club_members cashier_downline_read policy drift';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agents'
      AND policyname = 'agents_cashier_scoped_read' AND cmd = 'SELECT'
      AND roles @> ARRAY['authenticated']::name[]
      AND qual LIKE '%fn_club_viewer_can_transact(%'
  ) THEN
    RAISE EXCEPTION 'agents cashier-scoped policy drift';
  END IF;

  IF (SELECT count(*) FROM pg_trigger
      WHERE NOT tgisinternal AND tgenabled <> 'D'
        AND tgname IN (
          'trg_block_browser_balance_inserts',
          'trg_block_browser_balance_writes',
          'trg_block_browser_treasury_writes'
        )) <> 3 THEN
    RAISE EXCEPTION 'browser balance trigger contract drift';
  END IF;

  IF (SELECT count(*) FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indisvalid AND i.indisready
        AND c.relname IN (
          'club_members_cashier_tree_idx',
          'chip_transactions_club_from_created_idx',
          'chip_transactions_club_to_created_idx'
        )) <> 3 THEN
    RAISE EXCEPTION 'cashier performance index contract drift';
  END IF;

  SELECT lower(prosrc)
    INTO v_request_source
    FROM pg_proc
   WHERE oid = to_regprocedure('public.fn_request_chips(uuid,numeric,text,uuid)');
  IF v_request_source IS NULL OR v_request_source NOT LIKE '%if p_op_id is null then%' THEN
    RAISE EXCEPTION 'cashier request idempotency contract drift';
  END IF;

  v_telemetry_oid := to_regprocedure(
    'public.fn_record_cashier_operation(uuid,text,text,integer,integer,integer,integer,integer,text)'
  );
  IF v_telemetry_oid IS NULL
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_telemetry_oid)
     OR NOT coalesce((SELECT proconfig @> ARRAY['search_path=public, pg_temp']
                      FROM pg_proc WHERE oid = v_telemetry_oid), false)
     OR has_function_privilege('anon', v_telemetry_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_telemetry_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_telemetry_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'cashier telemetry RPC contract drift';
  END IF;
  SELECT lower(prosrc) INTO v_telemetry_source FROM pg_proc WHERE oid = v_telemetry_oid;
  IF v_telemetry_source NOT LIKE '%auth.uid()%'
     OR v_telemetry_source NOT LIKE '%fn_club_cashier_scope%'
     OR v_telemetry_source NOT LIKE '%cashier_operation%' THEN
    RAISE EXCEPTION 'cashier telemetry identity/scope/rate contract drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.cashier_operations'::regclass AND relrowsecurity
  ) OR EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'cashier_operations'
      AND cmd = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'cashier telemetry RLS contract drift';
  END IF;

  IF has_table_privilege('authenticated', 'public.cashier_operations', 'INSERT')
     OR has_table_privilege('authenticated', 'public.cashier_operations', 'SELECT')
     OR has_sequence_privilege('authenticated', 'public.cashier_operations_id_seq', 'USAGE')
     OR NOT has_table_privilege('service_role', 'public.v_cashier_health_hourly', 'SELECT')
     OR has_table_privilege('authenticated', 'public.v_cashier_health_hourly', 'SELECT') THEN
    RAISE EXCEPTION 'cashier telemetry ACL drift';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'rate_limits'
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
  ) OR has_table_privilege('anon', 'public.rate_limits', 'SELECT')
     OR has_table_privilege('anon', 'public.rate_limits', 'INSERT')
     OR has_table_privilege('anon', 'public.rate_limits', 'UPDATE')
     OR has_table_privilege('anon', 'public.rate_limits', 'DELETE')
     OR has_table_privilege('authenticated', 'public.rate_limits', 'SELECT')
     OR has_table_privilege('authenticated', 'public.rate_limits', 'INSERT')
     OR has_table_privilege('authenticated', 'public.rate_limits', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.rate_limits', 'DELETE') THEN
    RAISE EXCEPTION 'cashier limiter access boundary drift';
  END IF;
END;
$cashier_contract$;

-- The report must bound journal I/O by the requested club and its baseline.
DO $cashier_club_cover$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid=to_regclass('public.idx_chip_ledger_club_player_legs_cover')
      AND i.indrelid='public.chip_ledger'::regclass
      AND i.indisvalid AND i.indisready AND i.indislive
      AND pg_get_indexdef(i.indexrelid) =
        'CREATE INDEX idx_chip_ledger_club_player_legs_cover ON public.chip_ledger USING btree (club_id, created_at) INCLUDE (to_type, from_type, to_entity_id, from_entity_id, amount) WHERE ((club_id IS NOT NULL) AND ((to_type = ''player_wallet''::text) OR (from_type = ''player_wallet''::text)))'
  ) THEN
    RAISE EXCEPTION 'cashier club journal covering index drift';
  END IF;
END;
$cashier_club_cover$;

SELECT 'cashier release contract: versions, hashes, ACLs, RLS, triggers and indexes verified' AS result;
ROLLBACK;
