-- 20261002165749_a_chip_shop_refund_names_where_its_chips_come_from
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-02 16:57:49 UTC.
--
-- @live-proof: (SELECT position('ca-shop-refund-' IN prosrc) > 0 AND position('fn_ca_declare_ledger' IN prosrc) > 0 AND position('fn_ca_ledger_declaration_restore' IN prosrc) > 0 FROM pg_proc WHERE oid = 'public.fn_refund_shop_purchase(uuid,uuid,uuid,text)'::regprocedure)
-- @live-proof: (SELECT position('COALESCE(NULLIF(current_setting(''app.ledger_category'', true), ''''), ''player_funding'')' IN prosrc) > 0 FROM pg_proc WHERE oid = 'public.fn_credit_chips(uuid,uuid,numeric,text,jsonb)'::regprocedure)
--
-- Chip-drift launch plan, phase 1 (no silent money failures): the last money
-- door 20261002140203 left refusing by name.
--
-- WHAT WAS WRONG. 20261002140203 guarded fn_credit_chips: a caller that names
-- no counterparty is refused by name (fn_credit_chips_requires_a_declared_
-- counterparty), because the club_members journal would otherwise book the leg
-- against settlement_suspense. Its changelog lists fn_refund_shop_purchase as
-- an undeclared caller that "will refuse by name". It is the chip branch of the
-- owner/admin refund door (World Hub pages/api/club-arena/refund-purchase.js),
-- so a chip-currency refund that reaches the credit answers 500 "Refund failed".
-- Today none reaches it: all 14 unrefunded chip purchases (2026-03-21 ..
-- 2026-08-20) were redeemed, so the door answers already_redeemed first, and no
-- door sells for chips any more. It is fixed rather than left as a refusal
-- waiting for the first undelivered item.
--
-- WHERE THE CHIPS WENT. Each chip purchase wrote chip_transactions
-- 'chip_debit' with no recipient plus 'purchase': the price left circulation.
-- No club, union or house balance received it (none of the 15 has a
-- chip_ledger leg; they predate the journal). A refund puts back chips the
-- purchase retired, so its counterparty is issuance_reserve, category
-- 'refund', under the operation key 'ca-shop-refund-<purchase>' (the key the
-- Diamond branch of the same door already uses; issuance requires a key,
-- fn_ca_issuance_leg_is_registered). The caller's declaration is saved and
-- restored around the credit (fn_ca_ledger_declaration_save / _restore, as the
-- doors 20261002140203 declared do).
--
-- fn_credit_chips now keeps a category its caller declared and falls back to
-- 'player_funding' exactly as before. Its only other caller,
-- fn_purchase_club_chips, declares nothing (EXECUTE: postgres only, no live
-- caller), so for it nothing changes: it is still refused by name.
--
-- Both functions are edited by text replacement of the reviewed pre-image
-- (md5 pinned, reverse substitution checked). Neither is on the guard
-- watchlist. Grants are re-asserted unchanged.
--
-- ROLLED-BACK PROBE (production, 2026-10-02 ~16:35 UTC, one DO set ending in
-- RAISE EXCEPTION): purchase 128f44bc (20.00) with its inventory set back to
-- undelivered. Before this file the refund raised
-- fn_credit_chips_requires_a_declared_counterparty. After it: success, wallet
-- 6,140.02 -> 6,160.02, ONE leg issuance_reserve -> player_wallet 20.00,
-- category refund, key ca-shop-refund-128f44bc-..., 0 settlement_suspense
-- legs, the commit-time ledger check passed (SET CONSTRAINTS ALL IMMEDIATE),
-- and an outer caller's declaration (club_treasury) was restored.

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '60s';

DO $pin$
BEGIN
  IF md5(pg_get_functiondef('public.fn_credit_chips(uuid,uuid,numeric,text,jsonb)'::regprocedure))
     IS DISTINCT FROM 'eaa3996bab8e8d4b6fa6a20b79f326f3' THEN
    RAISE EXCEPTION 'fn_credit_chips is not the reviewed pre-image';
  END IF;
  IF md5(pg_get_functiondef('public.fn_refund_shop_purchase(uuid,uuid,uuid,text)'::regprocedure))
     IS DISTINCT FROM 'abf4bf54c469a4fe019d540d4fd11923' THEN
    RAISE EXCEPTION 'fn_refund_shop_purchase is not the reviewed pre-image';
  END IF;
END $pin$;

DO $credit$
DECLARE
  v_oid oid := 'public.fn_credit_chips(uuid,uuid,numeric,text,jsonb)'::regprocedure;
  v_def text := pg_get_functiondef('public.fn_credit_chips(uuid,uuid,numeric,text,jsonb)'::regprocedure);
  v_old text := E'  PERFORM set_config(''app.ledger_category'', ''player_funding'', true);\n';
  v_new text := E'  /* A category the calling door declared stands (2026-10-02,\n'
             || E'     20261002165749: a shop refund is a refund, not player funding). */\n'
             || E'  PERFORM set_config(''app.ledger_category'',\n'
             || E'    COALESCE(NULLIF(current_setting(''app.ledger_category'', true), ''''), ''player_funding''), true);\n';
  v_n int;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'fn_credit_chips: the category line occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> 'eaa3996bab8e8d4b6fa6a20b79f326f3' THEN
    RAISE EXCEPTION 'fn_credit_chips: the reverse substitution does not reproduce the pinned text';
  END IF;
END $credit$;

DO $refund$
DECLARE
  v_oid oid := 'public.fn_refund_shop_purchase(uuid,uuid,uuid,text)'::regprocedure;
  v_def text := pg_get_functiondef('public.fn_refund_shop_purchase(uuid,uuid,uuid,text)'::regprocedure);
  v_old1 text := E'  v_credit   jsonb;\n';
  v_new1 text := E'  v_credit   jsonb;\n'
              || E'  v_saved    jsonb;\n';
  v_old2 text := E'  ELSE\n'
              || E'    v_credit := public.fn_credit_chips(\n';
  v_new2 text := E'  ELSE\n'
              || E'    /* THE REFUND NAMES WHERE ITS CHIPS COME FROM (2026-10-02, 20261002165749).\n'
              || E'       A chip purchase retired its price (chip_debit, no recipient), so the\n'
              || E'       refund puts those chips back into circulation: issuance_reserve,\n'
              || E'       category refund, under this purchase''s own operation key. Undeclared,\n'
              || E'       fn_credit_chips refuses by name. The caller''s declaration is restored. */\n'
              || E'    v_saved := public.fn_ca_ledger_declaration_save(NULL);\n'
              || E'    PERFORM public.fn_ca_declare_ledger(''refund'', ''issuance_reserve'', NULL, NULL,\n'
              || E'      ''ca-shop-refund-'' || p_purchase_id::text, NULL);\n'
              || E'    v_credit := public.fn_credit_chips(\n';
  v_old3 text := E'    IF COALESCE((v_credit->>''success'')::boolean, false) IS NOT TRUE THEN\n'
              || E'      RAISE EXCEPTION ''refund credit failed: %'', COALESCE(v_credit->>''error'', ''unknown'');\n'
              || E'    END IF;\n';
  v_new3 text := v_old3
              || E'    PERFORM public.fn_ca_ledger_declaration_restore(v_saved);\n';
  v_n int;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'refund: declaration anchor occurs % times', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'refund: chip branch anchor occurs % times', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3);
  IF v_n <> 1 THEN RAISE EXCEPTION 'refund: credit check anchor occurs % times', v_n; END IF;
  EXECUTE replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3);
  IF md5(replace(replace(replace(pg_get_functiondef(v_oid), v_new3, v_old3), v_new2, v_old2), v_new1, v_old1))
     <> 'abf4bf54c469a4fe019d540d4fd11923' THEN
    RAISE EXCEPTION 'refund: the reverse substitution does not reproduce the pinned text';
  END IF;
END $refund$;

REVOKE ALL ON FUNCTION public.fn_credit_chips(uuid,uuid,numeric,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_refund_shop_purchase(uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_refund_shop_purchase(uuid,uuid,uuid,text) TO service_role;

COMMIT;
