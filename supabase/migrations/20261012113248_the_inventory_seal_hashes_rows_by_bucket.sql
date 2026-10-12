-- the_inventory_seal_hashes_its_rows_bucket_by_bucket
--
-- THE INVENTORY SEAL HASHES ITS ROWS BUCKET BY BUCKET (2026-10-12). Full
-- account: docs/changelog/2026-10-12-the-inventory-seal-hashes-its-rows-bucket-by-bucket.md.
--
-- The week ending 2026-10-12 07:00 UTC could not be sealed. Its 28 six-hour
-- layers were staged (1,590,639 touched rows) on top of the 1,846,384 rows of
-- the 2026-10-05 checkpoint, and every assembly since 08:30 UTC died with
-- 54000 "Cannot enlarge string buffer containing 1073741689 bytes by 442 more
-- bytes": rows_md5 was md5(string_agg(<every row>)), one text value, and the
-- week's rows (about 350 bytes of after_row each) now pass the 1 GB limit of a
-- single value. Last week fitted at about 700 MB; the inventory only grows.
-- Each failure raised a critical union_accounting_scheduler alert (13 since
-- 08:30) and job 272 rebuilt the 3.4M-row assembly every five minutes, so the
-- union week could not close.
--
-- Both seals (fn_union_pnl_inventory_seal_advance and the one-go
-- fn_union_pnl_inventory_checkpoint_seal) now take rows_md5 as the md5 of the
-- bucket hashes in order, each bucket being one source and the first two hex
-- digits of row_id, hashed in (source, row_id) order. No single value is
-- larger than one bucket. Weeks up to 2026-10-05 were sealed whole, so a
-- verify of one of them still recomputes the whole-string hash it was sealed
-- with. Nothing else reads rows_md5.
--
-- @live-proof: (SELECT position('THE ROWS HASH IS TAKEN BUCKET BY BUCKET' IN pg_get_functiondef('public.fn_union_pnl_inventory_seal_advance(timestamptz,boolean)'::regprocedure)) > 0 AND position('THE ROWS HASH IS TAKEN BUCKET BY BUCKET' IN pg_get_functiondef('public.fn_union_pnl_inventory_checkpoint_seal(timestamptz,boolean)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.ca_swap_once(p_src text, p_anchor text, p_new text, p_what text)
RETURNS text LANGUAGE plpgsql AS $swap$
DECLARE v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / length(p_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'BUCKET_HASH_ANCHOR_CHANGED: % found % times', p_what, v_n;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $patch$
DECLARE
  v_adv text := pg_get_functiondef('public.fn_union_pnl_inventory_seal_advance(timestamptz,boolean)'::regprocedure);
  v_one text := pg_get_functiondef('public.fn_union_pnl_inventory_checkpoint_seal(timestamptz,boolean)'::regprocedure);
  v_whole text := $a$   md5(COALESCE(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id,o_first_operation,COALESCE(o_after_row::text,'~')),E'\n'
    ORDER BY o_source_name,o_row_id) FILTER(WHERE o_kind='row'),'')),
$a$;
  v_into text := $a$  FROM pg_temp.union_pnl_inventory_seal$q$ INTO v_rows,v_issues,v_rows_md5,v_issues_md5,v_max;
$a$;
  v_bucket text := $a$  EXECUTE $q$SELECT md5(COALESCE(string_agg(x.h,E'\n' ORDER BY x.sn,x.b),'')) FROM (SELECT o_source_name sn,left(o_row_id::text,2) b,
    md5(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id,o_first_operation,COALESCE(o_after_row::text,'~')),E'\n'
     ORDER BY o_source_name,o_row_id)) h
    FROM pg_temp.union_pnl_inventory_seal WHERE o_kind='row' GROUP BY 1,2) x$q$ INTO v_rows_md5;
$a$;
  v_note text := $a$ -- THE ROWS HASH IS TAKEN BUCKET BY BUCKET (2026-10-12): one string of every
 -- row passed the 1 GB limit of a value at ~3M rows (54000). Each bucket (one
 -- source, the first two hex digits of row_id) is hashed in row order, and the
 -- bucket hashes are hashed in the same order.
$a$;
BEGIN
  IF position('THE ROWS HASH IS TAKEN BUCKET BY BUCKET' IN v_adv) > 0
     AND position('THE ROWS HASH IS TAKEN BUCKET BY BUCKET' IN v_one) > 0 THEN
    RAISE NOTICE 'BUCKET_HASH already applied';
    RETURN;
  END IF;
  IF md5(v_adv) IS DISTINCT FROM '52a411ca25dc73c6fa077835613f1fc8'
     OR md5(v_one) IS DISTINCT FROM '54e7ef8cfe674dc59489c530e644a39c' THEN
    RAISE EXCEPTION 'BUCKET_HASH_PREIMAGE_CHANGED';
  END IF;

  v_adv := pg_temp.ca_swap_once(v_adv, v_whole, $a$   NULL::text,
$a$, 'advance whole rows hash');
  v_adv := pg_temp.ca_swap_once(v_adv, v_into, v_into || v_note
    || $a$ -- Weeks up to 2026-10-05 were sealed whole; a verify of one recomputes that hash.
 IF p_verify AND p_at<='2026-10-05 07:00:00+00'::timestamptz THEN
  EXECUTE $q$SELECT md5(COALESCE(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id,o_first_operation,COALESCE(o_after_row::text,'~')),E'\n'
    ORDER BY o_source_name,o_row_id),'')) FROM pg_temp.union_pnl_inventory_seal WHERE o_kind='row'$q$ INTO v_rows_md5;
 ELSE
$a$ || v_bucket || $a$ END IF;
$a$, 'advance into');
  EXECUTE v_adv;

  v_one := pg_temp.ca_swap_once(v_one, v_whole, $a$   NULL::text,
$a$, 'one-go whole rows hash');
  v_one := pg_temp.ca_swap_once(v_one, v_into, v_into || v_note || v_bucket, 'one-go into');
  EXECUTE v_one;
END
$patch$;

DO $prove$
DECLARE
  v_adv text := pg_get_functiondef('public.fn_union_pnl_inventory_seal_advance(timestamptz,boolean)'::regprocedure);
  v_one text := pg_get_functiondef('public.fn_union_pnl_inventory_checkpoint_seal(timestamptz,boolean)'::regprocedure);
BEGIN
  IF position('THE ROWS HASH IS TAKEN BUCKET BY BUCKET' IN v_adv) = 0
     OR position('THE ROWS HASH IS TAKEN BUCKET BY BUCKET' IN v_one) = 0
     OR position('FILTER(WHERE o_kind=''row''),''''))' IN v_adv) > 0
     OR position('FILTER(WHERE o_kind=''row''),''''))' IN v_one) > 0
     OR position('SECURITY DEFINER' IN v_one) = 0
     OR position('SECURITY DEFINER' IN v_adv) > 0 THEN
    RAISE EXCEPTION 'BUCKET_HASH_RESULT_CHANGED';
  END IF;
END
$prove$;

COMMIT;
