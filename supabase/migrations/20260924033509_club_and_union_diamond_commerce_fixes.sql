-- 20260924033509_club_and_union_diamond_commerce_fixes.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20260922143541_club_and_union_diamond_commerce is installed (2026-09-23
-- 17:06 UTC) and unused: no trial, quote, purchase, mandate, refund,
-- sponsorship or notice exists. A line-by-line review, and a harness that now
-- presents identity exactly as PostgREST does (request.jwt.claims plus the
-- JWT role), found these defects. Each is fixed at its line and pinned by a
-- check in tests/sql/run-diamond-club-commerce.py that fails without the fix.
--
-- Money:
--  1. Cancelling a post-trial authorization needed a sku the page does not
--     send, so an owner could not stop the charge at trial end.
--  2. Mandates were unique per (right, sku): re-authorizing another product
--     added a second mandate that bought the next period twice (and broke the
--     status read). Now one mandate per right.
--  3. A renewal whose next period was already covered charged a later period
--     immediately. It now stops at needs_attention (period_already_covered).
--  4. Value credited into an upgrade could still be refunded; value refunded
--     could still be credited into an upgrade. Both are netted now.
--  5. Renewal execution locked the mandate before the scope; upgrade and
--     refund lock the scope first. Same order everywhere now (no deadlock).
--  6. A refund credits through add_diamonds_to_balance, which the profile
--     wallet guard admits only from a service context or a named door. A
--     staff browser refund therefore died mid-refund with a raw 42501. The
--     door now answers refund_requires_service_route in JSON before any work.
--     (Naming the door in the guard would be a permission change: left to the
--     owner.)
-- Correctness:
--  7. The catalog version was the latest publication second, so two
--     publications in one second left quotes alive. It now names the set.
--  8. A future-dated price publication retired the current price at once
--     (no price until the date). The current price now stays until then.
--  9. A service-role publication raised a raw trigger error; now JSON.
-- 10. A union coverage downgrade mid-period was taken at net 0; refused.
-- 11. An upgrade picked the prepaid next period instead of the current right.
-- 12. An over-reserved lot counted as negative availability in the lot proof.
-- 13. Receipts always said "effective", even after a full refund.
-- 14. A re-authorized mandate that failed again was never notified; notice
--     copy showed a raw sku and snake_case reason.
-- 15. Concurrent refunds with one key raised a unique error instead of the
--     replay; a malformed quantity raised a cast error instead of JSON; a
--     purchase could be committed under a kind its quote did not describe.
-- 16. Sponsorship eligibility read clubs.union_id, which the union's own
--     shell club carries without being a covered (union_clubs) club.
-- Additions the operator page reads: the union status lists covered_clubs
-- (so a sponsor can buy for them), a renewal names its sku and quantity, and
-- a receipt names the sponsorship that paid.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '3s';

-- The installed baseline, exactly: every function this migration replaces
-- still carries the body 20260922143541 installed, and the mandate table
-- still carries its original key. Anything else means another change landed
-- first; stop and review rather than overwrite it.
DO $baseline$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('fn_ca_commerce_catalog_version', '7fe7bde2f106803863bb4fa94869384b'),
    ('fn_ca_commerce_lot_snapshot', '7449bb42f7ed00e489a7dd04ccc8d738'),
    ('fn_ca_commerce_scope_status', 'c74e251f3cedfee23b2f86fc3ab4ab1a'),
    ('fn_ca_commerce_quote_impl', 'fc1c1243257e30b1cecd23573ce9aee4'),
    ('fn_ca_commerce_receipt_json', '5fc999a8dcaef560dd34fc3ad1a1cedd'),
    ('fn_ca_commerce_purchase_impl', '643979bf431c16f981383000d14aaaa3'),
    ('fn_ca_commerce_set_renewal', 'a6c8cba584baa4de2d5d76f6cca7c857'),
    ('fn_ca_commerce_execute_renewal', '64d506e510d79a96b7fb950a1a068007'),
    ('fn_ca_commerce_sponsorship_set', '29f750a57c7a06fe16aded1acee94823'),
    ('fn_ca_commerce_refund', 'ae6b951a3584ba3f06c6537cb183a787'),
    ('fn_ca_commerce_price_publish', '9ea3317bafa9d51a9d5ef9427b52b3ff')
  ) AS t(fn, md5) LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.fn) IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'commerce baseline changed: % is not the installed 20260922143541 body', r.fn;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.ca_commerce_renewal_mandates'::regclass
                  AND conname = 'ca_commerce_renewal_mandates_entitlement_id_sku_key') THEN
    RAISE EXCEPTION 'commerce baseline changed: the mandate key is not the installed one';
  END IF;
END $baseline$;

-- ---------------------------------------------------------------------------
-- One renewal obligation per right: a second mandate on the same right under
-- another sku would buy the following period twice. Fails closed if such a
-- pair already exists.
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_commerce_renewal_mandates DROP CONSTRAINT ca_commerce_renewal_mandates_entitlement_id_sku_key;
ALTER TABLE public.ca_commerce_renewal_mandates ADD CONSTRAINT ca_commerce_renewal_mandates_entitlement_id_key UNIQUE (entitlement_id);

-- ---------------------------------------------------------------------------
-- The corrected functions. Signatures, ownership and grants are unchanged
-- (CREATE OR REPLACE keeps the installed ACL). Union membership is the
-- union_clubs link everywhere in this boundary: the covered count,
-- sponsorship eligibility and the covered-club list.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_commerce_catalog_version() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT 'catalog:' || COALESCE(to_char(max(published_at) AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS'), 'none')
         || ':' || left(md5(COALESCE(string_agg(id::text || '@' || COALESCE(effective_to::text, ''), ',' ORDER BY id), '')), 12)
    FROM public.ca_commerce_price_versions WHERE status = 'published'
$$;

CREATE OR REPLACE FUNCTION public.fn_ca_commerce_lot_snapshot(p_user_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('lot_id', l.id, 'consumed', l.consumed,
           'available', GREATEST(l.issued - l.consumed - l.refunded - COALESCE(l.arena_reserved, 0), 0))
           ORDER BY l.created_at, l.id), '[]'::jsonb)
    FROM public.diamond_purchase_lots l
   WHERE l.user_id = p_user_id AND l.frozen_at IS NULL
$$;

CREATE OR REPLACE FUNCTION public.fn_ca_commerce_scope_status(p_scope_kind text, p_scope_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_trial public.ca_commerce_trials;
  v_owner uuid;
  v_settings public.ca_commerce_settings;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication_required');
  END IF;
  v_role := public.fn_ca_commerce_scope_role(p_scope_kind, p_scope_id, v_actor);
  IF v_role = 'none' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'access_denied');
  END IF;
  v_owner := public.fn_ca_commerce_scope_owner(p_scope_kind, p_scope_id);
  SELECT * INTO v_trial FROM public.fn_ca_commerce_scope_trial(p_scope_kind, p_scope_id);
  SELECT * INTO v_settings FROM public.ca_commerce_settings WHERE id = 1;
  RETURN jsonb_build_object(
    'success', true,
    'server_time', now(),
    'role', v_role,
    'scope_kind', p_scope_kind, 'scope_id', p_scope_id,
    'owner_id', v_owner,
    'policy_version', v_settings.policy_version,
    'checkout_enabled', v_settings.checkout_enabled,
    'admission_enforced_from', v_settings.admission_enforced_from,
    'roster_count', CASE WHEN p_scope_kind = 'club' THEN public.fn_ca_commerce_roster_count(p_scope_id) END,
    'covered_club_count', CASE WHEN p_scope_kind = 'union' THEN public.fn_ca_commerce_covered_club_count(p_scope_id) END,
    -- The clubs this union covers, so a sponsor can see which need capacity
    -- and buy it for them (R2 section 5). Same membership rule as the count.
    'covered_clubs', CASE WHEN p_scope_kind = 'union' THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'club_id', c.id, 'name', c.name,
        'roster_count', public.fn_ca_commerce_roster_count(c.id),
        'trial_active', public.fn_ca_commerce_in_trial('club', c.id),
        'capacity', (SELECT jsonb_build_object('sku', e.sku, 'capacity', e.capacity, 'ends_at', e.ends_at, 'source', e.source)
                       FROM public.ca_commerce_entitlements e
                      WHERE e.scope_kind = 'club' AND e.scope_id = c.id AND e.kind = 'capacity' AND e.state = 'effective'
                        AND e.starts_at <= now() AND (e.ends_at IS NULL OR e.ends_at > now())
                      ORDER BY e.capacity DESC NULLS LAST, e.ends_at DESC NULLS FIRST LIMIT 1)
      ) ORDER BY c.name, c.id)
      FROM public.union_clubs uc JOIN public.clubs c ON c.id = uc.club_id
      WHERE uc.union_id = p_scope_id AND COALESCE(c.lifecycle_status, 'active') <> 'retired'), '[]'::jsonb) END,
    'trial', CASE WHEN v_trial.id IS NULL THEN NULL ELSE jsonb_build_object(
      'trial_id', v_trial.id, 'trial_start', v_trial.trial_start, 'trial_end', v_trial.trial_end,
      'cohort', v_trial.cohort, 'active', now() >= v_trial.trial_start AND now() < v_trial.trial_end) END,
    'entitlements', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', e.id, 'sku', e.sku, 'kind', e.kind, 'capacity', e.capacity, 'quantity', e.quantity,
        'starts_at', e.starts_at, 'ends_at', e.ends_at, 'source', e.source, 'purchase_id', e.purchase_id,
        'net_paid', e.net_paid, 'value_basis', e.value_basis, 'revision', e.revision,
        'active', now() >= e.starts_at AND (e.ends_at IS NULL OR now() < e.ends_at),
        'scheduled', now() < e.starts_at,
        'renewal', (SELECT jsonb_build_object('mandate_id', m.id, 'state', m.state, 'sku', m.sku, 'quantity', m.quantity, 'max_diamonds', m.max_diamonds,
                       'due_at', m.due_at, 'payer_id', m.payer_id, 'last_result', m.last_result)
                      FROM public.ca_commerce_renewal_mandates m WHERE m.entitlement_id = e.id)
      ) ORDER BY e.starts_at DESC)
      FROM public.ca_commerce_entitlements e
      WHERE e.scope_kind = p_scope_kind AND e.scope_id = p_scope_id AND e.state = 'effective'
        AND (e.ends_at IS NULL OR e.ends_at > now() - interval '30 days')
    ), '[]'::jsonb),
    'sponsorships', CASE WHEN p_scope_kind = 'union' THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'club_id', s.club_id, 'payer_id', s.payer_id,
        'total_budget', s.total_budget, 'per_club_budget', s.per_club_budget, 'committed', s.committed,
        'effective_from', s.effective_from, 'effective_to', s.effective_to, 'state', s.state, 'revision', s.revision)
        ORDER BY s.created_at DESC)
      FROM public.ca_commerce_sponsorships s WHERE s.union_id = p_scope_id), '[]'::jsonb)
    ELSE COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'union_id', s.union_id, 'payer_id', s.payer_id,
        'remaining', s.total_budget - s.committed, 'per_club_budget', s.per_club_budget, 'effective_to', s.effective_to))
      FROM public.ca_commerce_sponsorships s
      JOIN public.union_clubs uc ON uc.club_id = p_scope_id AND uc.union_id = s.union_id
      WHERE s.state = 'active' AND (s.club_id IS NULL OR s.club_id = p_scope_id)
        AND s.effective_from <= now() AND (s.effective_to IS NULL OR s.effective_to > now())), '[]'::jsonb) END,
    'balance', CASE WHEN v_role = 'owner' THEN (SELECT COALESCE(p.diamonds, 0) FROM public.profiles p WHERE p.id = v_actor) END
  );
END $$;

CREATE OR REPLACE FUNCTION public.fn_ca_commerce_quote_impl(p_actor uuid, p_payer uuid, p_scope_kind text, p_scope_id uuid, p_lines jsonb, p_sponsorship_id uuid, p_renewal_max integer, p_purchase_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_settings public.ca_commerce_settings;
  v_line jsonb;
  v_product public.ca_commerce_products;
  v_price public.ca_commerce_price_versions;
  v_quantity integer;
  v_gross integer;
  v_credit integer;
  v_starts timestamptz;
  v_ends timestamptz;
  v_out jsonb := '[]'::jsonb;
  v_weights integer[] := '{}';
  v_grosses integer[] := '{}';
  v_credits integer[] := '{}';
  v_waivers integer[];
  v_total_gross integer := 0;
  v_total_credit integer := 0;
  v_total_waiver integer := 0;
  v_in_trial boolean;
  v_trial public.ca_commerce_trials;
  v_replaces uuid;
  v_old public.ca_commerce_entitlements;
  v_quote public.ca_commerce_quotes;
  v_i integer := 0;
  v_ctx text;
  v_basket text;
  v_now timestamptz := now();
  v_line_count integer;
  v_seen_kinds text[] := '{}';
  v_roster integer;
  v_sponsorship public.ca_commerce_sponsorships;
  v_upgrade_seen boolean := false;
BEGIN
  IF p_scope_kind NOT IN ('club','union') OR p_scope_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_scope');
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_lines');
  END IF;
  v_line_count := jsonb_array_length(p_lines);
  IF v_line_count < 1 OR v_line_count > 12 THEN
    RETURN jsonb_build_object('success', false, 'error', 'basket_size');
  END IF;
  SELECT * INTO v_settings FROM public.ca_commerce_settings WHERE id = 1;
  IF NOT v_settings.checkout_enabled THEN
    RETURN jsonb_build_object('success', false, 'error', 'checkout_disabled');
  END IF;
  IF public.fn_ca_commerce_scope_owner(p_scope_kind, p_scope_id) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'scope_not_found');
  END IF;
  IF p_sponsorship_id IS NOT NULL THEN
    SELECT * INTO v_sponsorship FROM public.ca_commerce_sponsorships WHERE id = p_sponsorship_id;
    IF v_sponsorship.id IS NULL OR v_sponsorship.state <> 'active' OR v_sponsorship.payer_id <> p_payer
       OR v_sponsorship.effective_from > v_now OR (v_sponsorship.effective_to IS NOT NULL AND v_sponsorship.effective_to <= v_now)
       OR p_scope_kind <> 'club' OR (v_sponsorship.club_id IS NOT NULL AND v_sponsorship.club_id <> p_scope_id)
       OR NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id = p_scope_id AND uc.union_id = v_sponsorship.union_id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'sponsorship_not_effective');
    END IF;
  END IF;

  SELECT * INTO v_trial FROM public.fn_ca_commerce_scope_trial(p_scope_kind, p_scope_id);
  v_in_trial := v_trial.id IS NOT NULL AND v_now >= v_trial.trial_start AND v_now < v_trial.trial_end;
  IF p_scope_kind = 'club' THEN v_roster := public.fn_ca_commerce_roster_count(p_scope_id); END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_i := v_i + 1;
    v_old := NULL;
    SELECT * INTO v_product FROM public.ca_commerce_products WHERE sku = v_line->>'sku';
    IF v_product.sku IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'unknown_sku', 'line', v_i);
    END IF;
    IF NOT v_product.supported THEN
      RETURN jsonb_build_object('success', false, 'error', 'sku_not_available', 'sku', v_product.sku, 'line', v_i);
    END IF;
    IF v_product.scope_kind <> p_scope_kind THEN
      RETURN jsonb_build_object('success', false, 'error', 'sku_scope_mismatch', 'sku', v_product.sku, 'line', v_i);
    END IF;
    IF v_product.kind = ANY (v_seen_kinds) THEN
      RETURN jsonb_build_object('success', false, 'error', 'duplicate_line', 'sku', v_product.sku, 'line', v_i);
    END IF;
    v_seen_kinds := v_seen_kinds || v_product.kind;
    SELECT * INTO v_price FROM public.ca_commerce_price_versions v
     WHERE v.sku = v_product.sku AND v.status = 'published' AND v.effective_from <= v_now AND (v.effective_to IS NULL OR v.effective_to > v_now);
    IF v_price.id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'no_published_price', 'sku', v_product.sku, 'line', v_i);
    END IF;

    -- A quantity must be a whole number; anything else is a refusal the page
    -- can name, never a raw cast error.
    IF v_line ? 'quantity' AND jsonb_typeof(v_line->'quantity') <> 'null'
       AND NOT (v_line->>'quantity') ~ '^[0-9]{1,6}$' THEN
      RETURN jsonb_build_object('success', false, 'error', 'quantity_out_of_range', 'sku', v_product.sku, 'line', v_i);
    END IF;
    v_quantity := COALESCE((v_line->>'quantity')::integer, 1);
    IF v_product.quantity_unit = 'flat' AND v_quantity <> 1 THEN
      RETURN jsonb_build_object('success', false, 'error', 'quantity_not_allowed', 'sku', v_product.sku, 'line', v_i);
    END IF;
    IF v_product.quantity_unit = 'covered_club' THEN
      IF v_quantity < 1 OR v_quantity > 500 THEN
        RETURN jsonb_build_object('success', false, 'error', 'quantity_out_of_range', 'sku', v_product.sku, 'line', v_i);
      END IF;
    END IF;
    IF v_product.term_kind <> 'period' THEN
      RETURN jsonb_build_object('success', false, 'error', 'term_not_supported_yet', 'sku', v_product.sku, 'line', v_i);
    END IF;

    v_gross := public.fn_ca_commerce_line_gross(v_price, v_quantity);
    v_credit := 0;
    v_replaces := NULL;

    -- Period placement: a renewal or first purchase begins at the later of
    -- now, the trial end and the end of the current effective right of the
    -- same kind. An upgrade replaces the current right from now and credits
    -- its unused whole-diamond remainder (R2 section 4.4).
    SELECT * INTO v_old FROM public.ca_commerce_entitlements e
     WHERE e.scope_kind = p_scope_kind AND e.scope_id = p_scope_id AND e.kind = v_product.kind
       AND e.state = 'effective' AND e.ends_at IS NOT NULL AND e.ends_at > v_now
     ORDER BY e.ends_at DESC LIMIT 1;

    IF p_purchase_kind = 'upgrade' THEN
      -- An upgrade amends the right in effect now, even when a later period
      -- of the same kind is already prepaid behind it.
      SELECT * INTO v_old FROM public.ca_commerce_entitlements e
       WHERE e.scope_kind = p_scope_kind AND e.scope_id = p_scope_id AND e.kind = v_product.kind
         AND e.state = 'effective' AND e.ends_at IS NOT NULL AND e.ends_at > v_now AND e.starts_at <= v_now
       ORDER BY e.ends_at DESC LIMIT 1;
      IF v_old.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'nothing_to_upgrade', 'sku', v_product.sku, 'line', v_i);
      END IF;
      IF v_old.sku = v_product.sku AND v_old.quantity = v_quantity THEN
        RETURN jsonb_build_object('success', false, 'error', 'same_capacity', 'sku', v_product.sku, 'line', v_i);
      END IF;
      IF (v_product.kind = 'capacity' AND v_product.capacity < v_old.capacity)
         OR (v_product.quantity_unit = 'covered_club' AND v_quantity < v_old.quantity) THEN
        RETURN jsonb_build_object('success', false, 'error', 'downgrade_applies_at_next_period', 'sku', v_product.sku, 'line', v_i);
      END IF;
      v_replaces := v_old.id;
      v_starts := v_now;
      v_ends := v_old.ends_at;
      -- Unused remainder of the actual net paid right, exact rational time,
      -- floored to whole diamonds so residues never manufacture value. Value
      -- already returned by a refund of that right is not credited again.
      v_credit := floor((GREATEST(v_old.value_basis - COALESCE((SELECT SUM(r.gross) FROM public.ca_commerce_refunds r
                          WHERE r.purchase_id = v_old.purchase_id AND r.line_index = v_old.line_index), 0), 0)::numeric
                         * extract(epoch FROM (v_old.ends_at - v_now))) / extract(epoch FROM (v_old.ends_at - v_old.starts_at)))::integer;
      -- The new line covers only the remaining time of a full term: the new
      -- list price prorated over the product's own term length, ceiling so a
      -- rounding residue is never free capacity.
      v_gross := ceil((v_gross::numeric * extract(epoch FROM (v_old.ends_at - v_now))) / (v_product.term_hours * 3600)::numeric)::integer;
      v_credit := LEAST(v_credit, v_gross);
      v_upgrade_seen := true;
    ELSE
      -- A first purchase starts now (or at the trial end while the trial is
      -- running). A renewal starts exactly where the current right ends, and
      -- a renewal inside the accepted lateness window keeps the period
      -- continuous (D51: no gap). Beyond that window a new period starts now.
      v_starts := v_now;
      IF v_in_trial THEN v_starts := v_trial.trial_end; END IF;
      -- Continuity is the renewal consumer's contract: an automatic renewal
      -- executed inside the accepted lateness window starts exactly where the
      -- trial or the previous period ended. A manual purchase after a lapse
      -- starts now; nobody pays for hours already gone.
      IF p_purchase_kind = 'renewal' AND v_trial.id IS NOT NULL AND v_trial.trial_end <= v_now
         AND v_trial.trial_end > v_now - make_interval(hours => v_settings.renewal_lateness_hours) THEN
        v_starts := v_trial.trial_end;
      END IF;
      IF v_old.id IS NOT NULL THEN v_starts := GREATEST(v_starts, v_old.ends_at); END IF;
      IF v_old.id IS NULL AND p_purchase_kind = 'renewal' THEN
        SELECT * INTO v_old FROM public.ca_commerce_entitlements e
         WHERE e.scope_kind = p_scope_kind AND e.scope_id = p_scope_id AND e.kind = v_product.kind
           AND e.state = 'effective' AND e.ends_at IS NOT NULL AND e.ends_at <= v_now
           AND e.ends_at > v_now - make_interval(hours => v_settings.renewal_lateness_hours)
         ORDER BY e.ends_at DESC LIMIT 1;
        IF v_old.id IS NOT NULL AND NOT v_in_trial THEN v_starts := v_old.ends_at; END IF;
        v_old := NULL;
      END IF;
      v_ends := v_starts + make_interval(hours => v_product.term_hours);
    END IF;

    IF v_product.kind = 'capacity' AND v_roster IS NOT NULL AND v_roster > v_product.capacity THEN
      RETURN jsonb_build_object('success', false, 'error', 'roster_exceeds_capacity', 'sku', v_product.sku, 'line', v_i,
        'roster_count', v_roster, 'capacity', v_product.capacity);
    END IF;

    v_grosses := v_grosses || v_gross;
    v_credits := v_credits || v_credit;
    v_weights := v_weights || (v_gross - v_credit);
    v_total_gross := v_total_gross + v_gross;
    v_total_credit := v_total_credit + v_credit;
    v_out := v_out || jsonb_build_object(
      'index', v_i - 1, 'sku', v_product.sku, 'kind', v_product.kind, 'title', v_product.title,
      'price_version_id', v_price.id, 'price_version', v_price.version, 'unit_diamonds', v_price.diamonds,
      'price_rule', v_price.price_rule, 'quantity', v_quantity, 'capacity', v_product.capacity,
      'term_hours', v_product.term_hours, 'starts_at', v_starts, 'ends_at', v_ends,
      'gross', v_gross, 'credit', v_credit, 'comparison_adjustment', 0, 'waiver', 0, 'net', v_gross - v_credit,
      'replaces_entitlement_id', v_replaces, 'included_note', v_product.included_note,
      'comparison_verified', v_price.comparison_verified);
  END LOOP;

  -- Trial waiver: under the recommended contract every included operating
  -- service is usable during the trial without a purchase (the admission
  -- policy answers 'trial'), and a paid period begins no earlier than the
  -- trial end. A purchase made inside the trial is therefore scheduled at
  -- the trial end with nothing waived; the waiver columns stay at zero and
  -- exist so a future waived line is recorded, never silently discounted.
  v_waivers := array_fill(0, ARRAY[v_line_count]);
  FOR v_i IN 1 .. v_line_count LOOP
    v_out := jsonb_set(v_out, ARRAY[(v_i - 1)::text, 'waiver'], to_jsonb(v_waivers[v_i]));
    v_out := jsonb_set(v_out, ARRAY[(v_i - 1)::text, 'net'], to_jsonb(v_grosses[v_i] - v_credits[v_i] - v_waivers[v_i]));
  END LOOP;

  v_basket := md5(p_scope_kind || ':' || p_scope_id::text || ':' || p_payer::text || ':' || COALESCE(p_sponsorship_id::text, '') || ':' || p_purchase_kind || ':' || v_out::text);
  v_ctx := md5(COALESCE(public.fn_ca_commerce_scope_owner(p_scope_kind, p_scope_id)::text, '') || ':' || public.fn_ca_commerce_catalog_version()
              || ':' || COALESCE(v_trial.trial_end::text, '') || ':' || COALESCE((SELECT string_agg(e.id::text, ',' ORDER BY e.id) FROM public.ca_commerce_entitlements e WHERE e.scope_kind = p_scope_kind AND e.scope_id = p_scope_id AND e.state = 'effective' AND (e.ends_at IS NULL OR e.ends_at > v_now)), ''));

  INSERT INTO public.ca_commerce_quotes (actor_id, payer_id, scope_kind, scope_id, sponsorship_id, lines, basket_hash, context_hash, catalog_version,
    gross, credits, comparison_adjustment, trial_waiver, net, trial_id, renewal_max_diamonds, expires_at)
  VALUES (p_actor, p_payer, p_scope_kind, p_scope_id, p_sponsorship_id, v_out, v_basket, v_ctx, public.fn_ca_commerce_catalog_version(),
    v_total_gross, v_total_credit, 0, v_total_waiver, v_total_gross - v_total_credit - v_total_waiver, v_trial.id, p_renewal_max, v_now + v_settings.quote_ttl)
  RETURNING * INTO v_quote;

  RETURN jsonb_build_object('success', true, 'quote_id', v_quote.id, 'expires_at', v_quote.expires_at,
    'catalog_version', v_quote.catalog_version, 'payer_id', p_payer, 'sponsorship_id', p_sponsorship_id,
    'purchase_kind', p_purchase_kind, 'lines', v_out,
    'gross', v_quote.gross, 'credits', v_quote.credits, 'comparison_adjustment', 0, 'trial_waiver', v_quote.trial_waiver, 'net', v_quote.net,
    'nominal_cents', v_quote.net, 'trial_active', v_in_trial, 'trial_end', v_trial.trial_end,
    'available_balance', (SELECT COALESCE(p.diamonds, 0) FROM public.profiles p WHERE p.id = p_payer),
    'renewal_max_diamonds', p_renewal_max);
END $$;

CREATE OR REPLACE FUNCTION public.fn_ca_commerce_receipt_json(p_purchase public.ca_commerce_purchases, p_replay boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'success', true,
    'purchase_id', p_purchase.id,
    'quote_id', p_purchase.quote_id,
    'is_replay', p_replay,
    'original_total_diamonds', p_purchase.net,
    'original_gross_diamonds', p_purchase.gross,
    'trial_waiver', p_purchase.trial_waiver,
    'charged_this_attempt', CASE WHEN p_replay THEN 0 ELSE p_purchase.net END,
    'payer_id', p_purchase.payer_id,
    'scope_kind', p_purchase.scope_kind, 'scope_id', p_purchase.scope_id,
    'sponsorship_id', p_purchase.sponsorship_id,
    'kind', p_purchase.kind,
    'diamond_tx_id', p_purchase.diamond_tx_id,
    'mint_op_id', p_purchase.mint_op_id,
    'catalog_version', p_purchase.catalog_version,
    'delivery_status', 'delivered',
    -- The present state of the rights this receipt granted (R2 3.3): a
    -- refunded or superseded right is never reported as still effective.
    'entitlement_status', COALESCE((SELECT CASE WHEN count(DISTINCT e.state) = 1 THEN min(e.state) ELSE 'mixed' END
                                      FROM public.ca_commerce_entitlements e WHERE e.purchase_id = p_purchase.id), 'effective'),
    'committed_at', p_purchase.created_at,
    'lines', p_purchase.lines
  )
$$;

CREATE OR REPLACE FUNCTION public.fn_ca_commerce_purchase_impl(p_actor uuid, p_quote_id uuid, p_request_key text, p_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_settings public.ca_commerce_settings;
  v_quote public.ca_commerce_quotes;
  v_existing public.ca_commerce_purchases;
  v_purchase public.ca_commerce_purchases;
  v_purchase_id uuid := gen_random_uuid();
  v_request_hash text;
  v_now timestamptz := now();
  v_trial public.ca_commerce_trials;
  v_ctx text;
  v_line jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_ent public.ca_commerce_entitlements;
  v_old public.ca_commerce_entitlements;
  v_before jsonb;
  v_after jsonb;
  v_expected_purchased integer;
  v_actual_purchased integer;
  v_available_purchased integer;
  v_balance integer;
  v_deduct jsonb;
  v_tx public.diamond_transactions;
  v_mint public.ca_mint_ledger;
  v_alloc jsonb := '[]'::jsonb;
  v_sponsorship public.ca_commerce_sponsorships;
  v_club_committed integer;
  v_ref text;
  v_owner uuid;
  v_mandate_id uuid;
  v_receipt_url text;
BEGIN
  IF p_request_key IS NULL OR length(p_request_key) < 8 OR length(p_request_key) > 200 THEN
    RETURN jsonb_build_object('success', false, 'error', 'request_key_required');
  END IF;
  v_request_hash := md5(COALESCE(p_quote_id::text, '') || ':' || p_kind);

  -- Barrier 1: request identity. Same key and payload replays the receipt;
  -- same key with a different payload refuses (D04, D05).
  SELECT * INTO v_existing FROM public.ca_commerce_purchases WHERE actor_id = p_actor AND request_key = p_request_key;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.request_hash <> v_request_hash THEN
      RETURN jsonb_build_object('success', false, 'error', 'request_key_reused');
    END IF;
    RETURN public.fn_ca_commerce_receipt_json(v_existing, true);
  END IF;

  SELECT * INTO v_quote FROM public.ca_commerce_quotes WHERE id = p_quote_id FOR UPDATE;
  IF v_quote.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'quote_not_found');
  END IF;
  IF v_quote.actor_id <> p_actor THEN
    RETURN jsonb_build_object('success', false, 'error', 'quote_belongs_to_another_actor');
  END IF;
  -- Barrier 2: quote consumption. A consumed quote returns its purchase only
  -- to the same actor and never charges again (D31).
  IF v_quote.status = 'consumed' THEN
    SELECT * INTO v_existing FROM public.ca_commerce_purchases WHERE id = v_quote.purchase_id;
    RETURN public.fn_ca_commerce_receipt_json(v_existing, true);
  END IF;
  IF v_quote.status <> 'open' OR v_quote.expires_at <= v_now THEN
    IF v_quote.status = 'open' THEN
      UPDATE public.ca_commerce_quotes SET status = 'expired' WHERE id = v_quote.id;
    END IF;
    RETURN jsonb_build_object('success', false, 'error', 'quote_expired', 'requote', true);
  END IF;
  -- The receipt names what was bought: an upgrade quote (its lines replace a
  -- right) is committed as an upgrade and nothing else is (renewals are the
  -- consumer's own kind). A mismatched kind is refused, never relabelled.
  IF p_kind IN ('purchase', 'upgrade')
     AND (p_kind = 'upgrade') IS DISTINCT FROM EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_quote.lines) l WHERE COALESCE(l->>'replaces_entitlement_id', '') <> '') THEN
    RETURN jsonb_build_object('success', false, 'error', 'purchase_kind_mismatch');
  END IF;

  SELECT * INTO v_settings FROM public.ca_commerce_settings WHERE id = 1;
  IF NOT v_settings.checkout_enabled THEN
    RETURN jsonb_build_object('success', false, 'error', 'checkout_disabled');
  END IF;

  -- Serialize every commerce writer for this scope (barrier 3; the overlap
  -- predicate below is only valid under this lock).
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_scope:' || v_quote.scope_kind || ':' || v_quote.scope_id::text, 0));

  -- Recheck material context: owner, catalog, trial end and effective rights.
  v_owner := public.fn_ca_commerce_scope_owner(v_quote.scope_kind, v_quote.scope_id);
  SELECT * INTO v_trial FROM public.fn_ca_commerce_scope_trial(v_quote.scope_kind, v_quote.scope_id);
  v_ctx := md5(COALESCE(v_owner::text, '') || ':' || public.fn_ca_commerce_catalog_version()
              || ':' || COALESCE(v_trial.trial_end::text, '') || ':' || COALESCE((SELECT string_agg(e.id::text, ',' ORDER BY e.id) FROM public.ca_commerce_entitlements e WHERE e.scope_kind = v_quote.scope_kind AND e.scope_id = v_quote.scope_id AND e.state = 'effective' AND (e.ends_at IS NULL OR e.ends_at > v_now)), ''));
  IF v_ctx <> v_quote.context_hash THEN
    UPDATE public.ca_commerce_quotes SET status = 'withdrawn' WHERE id = v_quote.id;
    RETURN jsonb_build_object('success', false, 'error', 'context_changed', 'requote', true);
  END IF;
  IF v_quote.sponsorship_id IS NULL AND v_owner <> v_quote.payer_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'payer_no_longer_owner', 'requote', true);
  END IF;
  -- No operator-service debit before its paid period begins (R2 section
  -- 4.6): inside the trial the owner records a post-trial authorization
  -- instead, and the renewal consumer buys the first period at trial end.
  IF v_quote.net > 0 AND v_trial.id IS NOT NULL AND v_now >= v_trial.trial_start AND v_now < v_trial.trial_end THEN
    RETURN jsonb_build_object('success', false, 'error', 'trial_active_authorize_instead', 'trial_end', v_trial.trial_end);
  END IF;
  -- The canonical self-payer guard inside deduct_diamonds needs the payer's
  -- own session or the trusted service route. Say so before any write.
  IF v_quote.net > 0 AND COALESCE(auth.role(), '') <> 'service_role' AND auth.uid() IS DISTINCT FROM v_quote.payer_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'sponsor_route_required');
  END IF;

  -- Sponsorship budget under its row lock (D43, D44).
  IF v_quote.sponsorship_id IS NOT NULL THEN
    SELECT * INTO v_sponsorship FROM public.ca_commerce_sponsorships WHERE id = v_quote.sponsorship_id FOR UPDATE;
    IF v_sponsorship.state <> 'active' OR v_sponsorship.payer_id <> v_quote.payer_id
       OR v_sponsorship.effective_from > v_now OR (v_sponsorship.effective_to IS NOT NULL AND v_sponsorship.effective_to <= v_now)
       OR NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id = v_quote.scope_id AND uc.union_id = v_sponsorship.union_id)
       OR (v_sponsorship.club_id IS NOT NULL AND v_sponsorship.club_id <> v_quote.scope_id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'sponsorship_not_effective');
    END IF;
    IF v_sponsorship.committed + v_quote.net > v_sponsorship.total_budget THEN
      RETURN jsonb_build_object('success', false, 'error', 'sponsorship_budget_exceeded', 'remaining', v_sponsorship.total_budget - v_sponsorship.committed);
    END IF;
    IF v_sponsorship.per_club_budget IS NOT NULL THEN
      SELECT COALESCE(SUM(p.net), 0)::integer INTO v_club_committed FROM public.ca_commerce_purchases p
       WHERE p.sponsorship_id = v_sponsorship.id AND p.scope_id = v_quote.scope_id;
      IF v_club_committed + v_quote.net > v_sponsorship.per_club_budget THEN
        RETURN jsonb_build_object('success', false, 'error', 'sponsorship_club_budget_exceeded', 'remaining', v_sponsorship.per_club_budget - v_club_committed);
      END IF;
    END IF;
  END IF;

  -- Business identity: no overlapping effective right of the same kind
  -- except the one an upgrade replaces (D32).
  FOR v_line IN SELECT * FROM jsonb_array_elements(v_quote.lines) LOOP
    IF EXISTS (
      SELECT 1 FROM public.ca_commerce_entitlements e
       WHERE e.scope_kind = v_quote.scope_kind AND e.scope_id = v_quote.scope_id AND e.kind = v_line->>'kind'
         AND e.state = 'effective' AND e.ends_at IS NOT NULL
         AND e.id IS DISTINCT FROM NULLIF(v_line->>'replaces_entitlement_id', '')::uuid
         AND tstzrange(e.starts_at, e.ends_at, '[)') && tstzrange((v_line->>'starts_at')::timestamptz, (v_line->>'ends_at')::timestamptz, '[)')
    ) THEN
      UPDATE public.ca_commerce_quotes SET status = 'withdrawn' WHERE id = v_quote.id;
      RETURN jsonb_build_object('success', false, 'error', 'period_already_covered', 'requote', true);
    END IF;
  END LOOP;

  IF v_quote.net > 0 THEN
    v_ref := 'ca-commerce:' || v_purchase_id::text;
    -- The payer's wallet row is the lock every canonical writer takes first;
    -- holding it here makes the before/after lot snapshots this operation's
    -- own evidence (R2-A03) and places it after the scope and sponsorship
    -- locks in the documented order.
    PERFORM 1 FROM public.profiles p WHERE p.id = v_quote.payer_id FOR UPDATE;
    v_before := public.fn_ca_commerce_lot_snapshot(v_quote.payer_id);
    SELECT COALESCE(SUM((l->>'available')::bigint), 0)::integer INTO v_available_purchased FROM jsonb_array_elements(v_before) l;
    v_expected_purchased := LEAST(v_quote.net, GREATEST(v_available_purchased, 0));

    v_deduct := public.deduct_diamonds(v_quote.payer_id, v_quote.net,
      'Club And Union Diamond Costs: ' || v_quote.scope_kind || ' ' || v_quote.scope_id::text,
      'club_commerce', 'club_commerce',
      jsonb_build_object('purchase_id', v_purchase_id, 'quote_id', v_quote.id, 'scope_kind', v_quote.scope_kind, 'scope_id', v_quote.scope_id, 'kind', p_kind),
      v_ref, 0);
    IF NOT COALESCE((v_deduct->>'success')::boolean, false) THEN
      IF v_deduct->>'error' = 'Insufficient diamonds' THEN
        RAISE EXCEPTION 'CA_COMMERCE_INSUFFICIENT_DIAMONDS' USING DETAIL = COALESCE(v_deduct->>'balance', '0');
      END IF;
      RAISE EXCEPTION 'CA_COMMERCE_DEBIT_REFUSED' USING DETAIL = COALESCE(v_deduct->>'error', 'unknown');
    END IF;
    IF COALESCE((v_deduct->>'idempotent')::boolean, false) THEN
      RAISE EXCEPTION 'CA_COMMERCE_DEBIT_REFERENCE_REUSED' USING DETAIL = v_ref;
    END IF;

    -- Postcondition 1: the journal row for this operation, exact amount and class.
    SELECT * INTO v_tx FROM public.diamond_transactions t WHERE t.user_id = v_quote.payer_id AND t.reference_id = v_ref;
    IF v_tx.id IS NULL OR v_tx.amount <> -v_quote.net OR v_tx.issuance_class <> 'spend' OR v_tx.counterparty <> 'revenue:club_commerce' THEN
      RAISE EXCEPTION 'CA_COMMERCE_JOURNAL_UNPROVED' USING DETAIL = v_ref;
    END IF;
    -- Postcondition 2: the exact linked Mint retirement (R2-A04). The helper
    -- can swallow its own failure; the row is what counts.
    SELECT * INTO v_mint FROM public.ca_mint_ledger m WHERE m.diamond_tx_id = v_tx.id;
    IF v_mint.id IS NULL OR v_mint.action <> 'burn' OR v_mint.asset <> 'diamonds' OR v_mint.amount <> v_quote.net
       OR v_mint.holder_id IS DISTINCT FROM v_quote.payer_id THEN
      RAISE EXCEPTION 'CA_COMMERCE_REGISTER_UNPROVED' USING DETAIL = v_ref;
    END IF;
    -- Postcondition 3: persisted purchased-lot deltas equal the expected
    -- split (R2-A03). The helper's accumulator is not evidence.
    v_after := public.fn_ca_commerce_lot_snapshot(v_quote.payer_id);
    SELECT COALESCE(SUM((a->>'consumed')::bigint - (b->>'consumed')::bigint), 0)::integer,
           COALESCE(jsonb_agg(jsonb_build_object('lot_id', a->>'lot_id', 'consumed_delta', (a->>'consumed')::bigint - (b->>'consumed')::bigint)) FILTER (WHERE (a->>'consumed')::bigint <> (b->>'consumed')::bigint), '[]'::jsonb)
      INTO v_actual_purchased, v_alloc
      FROM jsonb_array_elements(v_after) a JOIN jsonb_array_elements(v_before) b ON a->>'lot_id' = b->>'lot_id';
    IF v_actual_purchased <> v_expected_purchased THEN
      RAISE EXCEPTION 'CA_COMMERCE_LOTS_UNPROVED' USING DETAIL = format('expected %s consumed %s', v_expected_purchased, v_actual_purchased);
    END IF;
    v_balance := (v_deduct->>'balance')::integer;

    IF v_quote.sponsorship_id IS NOT NULL THEN
      UPDATE public.ca_commerce_sponsorships SET committed = committed + v_quote.net WHERE id = v_quote.sponsorship_id;
    END IF;
  END IF;

  -- The receipt, written once with its proven accounting identities.
  INSERT INTO public.ca_commerce_purchases (id, quote_id, actor_id, payer_id, request_key, request_hash, scope_kind, scope_id, sponsorship_id, kind,
    gross, net, trial_waiver, lines, diamond_tx_id, mint_op_id, lot_allocation, catalog_version, policy_version)
  VALUES (v_purchase_id, v_quote.id, p_actor, v_quote.payer_id, p_request_key, v_request_hash, v_quote.scope_kind, v_quote.scope_id, v_quote.sponsorship_id, p_kind,
    v_quote.gross, v_quote.net, v_quote.trial_waiver, v_quote.lines, v_tx.id, v_mint.op_id, v_alloc, v_quote.catalog_version, v_settings.policy_version)
  RETURNING * INTO v_purchase;

  -- Rights.
  FOR v_line IN SELECT * FROM jsonb_array_elements(v_quote.lines) LOOP
    v_old := NULL;
    v_mandate_id := NULL;
    IF NULLIF(v_line->>'replaces_entitlement_id', '') IS NOT NULL THEN
      SELECT * INTO v_old FROM public.ca_commerce_entitlements WHERE id = (v_line->>'replaces_entitlement_id')::uuid FOR UPDATE;
      IF v_old.id IS NULL OR v_old.state <> 'effective' THEN
        RAISE EXCEPTION 'CA_COMMERCE_UPGRADE_TARGET_GONE';
      END IF;
    END IF;
    INSERT INTO public.ca_commerce_entitlements (scope_kind, scope_id, sku, kind, capacity, quantity, starts_at, ends_at, source, purchase_id, line_index, net_paid, value_basis, revision)
    VALUES (v_quote.scope_kind, v_quote.scope_id, v_line->>'sku', v_line->>'kind', NULLIF(v_line->>'capacity', '')::integer,
            COALESCE((v_line->>'quantity')::integer, 1), (v_line->>'starts_at')::timestamptz, (v_line->>'ends_at')::timestamptz,
            CASE WHEN v_quote.sponsorship_id IS NULL THEN 'purchase' ELSE 'sponsor' END, v_purchase.id, (v_line->>'index')::integer,
            (v_line->>'net')::integer, (v_line->>'net')::integer + (v_line->>'credit')::integer,
            CASE WHEN v_old.id IS NULL THEN 1 ELSE v_old.revision + 1 END)
    RETURNING * INTO v_ent;
    IF v_old.id IS NOT NULL THEN
      -- The replaced right ends at the quoted switch instant so the two
      -- periods abut exactly: no overlap, no gap, no double coverage.
      UPDATE public.ca_commerce_entitlements SET state = 'superseded', superseded_by = v_ent.id, ends_at = v_ent.starts_at, updated_at = v_now WHERE id = v_old.id;
      -- A mandate on the replaced right follows the replacement at the same ceiling.
      UPDATE public.ca_commerce_renewal_mandates SET entitlement_id = v_ent.id, sku = v_ent.sku, quantity = v_ent.quantity, due_at = v_ent.ends_at, updated_at = v_now
       WHERE entitlement_id = v_old.id AND state = 'authorized';
    END IF;
    IF v_quote.renewal_max_diamonds IS NOT NULL AND v_quote.sponsorship_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.ca_commerce_renewal_mandates m WHERE m.entitlement_id = v_ent.id) THEN
      INSERT INTO public.ca_commerce_renewal_mandates (entitlement_id, scope_kind, scope_id, payer_id, sku, quantity, max_diamonds, due_at, accepted_by)
      VALUES (v_ent.id, v_quote.scope_kind, v_quote.scope_id, v_quote.payer_id, v_ent.sku, v_ent.quantity, v_quote.renewal_max_diamonds, v_ent.ends_at, p_actor)
      RETURNING id INTO v_mandate_id;
    END IF;
    v_lines := v_lines || (v_line || jsonb_build_object('entitlement_id', v_ent.id, 'mandate_id', v_mandate_id));
  END LOOP;

  UPDATE public.ca_commerce_quotes SET status = 'consumed', purchase_id = v_purchase.id WHERE id = v_quote.id;

  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('purchase_committed', p_actor, v_quote.scope_kind, v_quote.scope_id, v_purchase.id,
          jsonb_build_object('net', v_quote.net, 'gross', v_quote.gross, 'kind', p_kind, 'payer_id', v_quote.payer_id, 'diamond_tx_id', v_purchase.diamond_tx_id));

  v_receipt_url := '/hub/club-arena/' || v_quote.scope_kind || 's/' || v_quote.scope_id::text || '/diamond-costs';
  PERFORM public.fn_ca_commerce_notice(v_quote.payer_id, 'receipt:' || v_purchase.id::text, 'club_commerce_receipt',
    'Diamond Receipt: ' || v_quote.net::text || ' Diamonds',
    CASE WHEN v_quote.net = 0 THEN 'No Diamonds Were Charged For This Order.' ELSE v_quote.net::text || ' Diamonds Were Charged For Club And Union Services.' END,
    v_receipt_url, jsonb_build_object('purchase_id', v_purchase.id, 'net', v_quote.net));

  RETURN public.fn_ca_commerce_receipt_json(v_purchase, false) || jsonb_build_object('lines', v_lines, 'balance_after', v_balance, 'balance_observed_at', v_now);
END $$;

CREATE OR REPLACE FUNCTION public.fn_ca_commerce_set_renewal(p_entitlement_id uuid, p_enabled boolean, p_max_diamonds integer DEFAULT NULL, p_sku text DEFAULT NULL, p_quantity integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_ent public.ca_commerce_entitlements;
  v_mandate public.ca_commerce_renewal_mandates;
  v_purchase public.ca_commerce_purchases;
  v_product public.ca_commerce_products;
  v_sku text;
  v_quantity integer;
BEGIN
  IF v_actor IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'authentication_required'); END IF;
  SELECT * INTO v_ent FROM public.ca_commerce_entitlements WHERE id = p_entitlement_id FOR UPDATE;
  IF v_ent.id IS NULL OR v_ent.state <> 'effective' OR v_ent.ends_at IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'entitlement_not_renewable');
  END IF;
  IF public.fn_ca_commerce_scope_role(v_ent.scope_kind, v_ent.scope_id, v_actor) <> 'owner' THEN
    RETURN jsonb_build_object('success', false, 'error', 'owner_required');
  END IF;
  IF v_ent.source = 'trial' THEN
    -- A post-trial authorization: the owner names the product and ceiling;
    -- the consumer buys the first paid period at the trial end (R2 4.6).
    v_sku := p_sku;
    v_quantity := COALESCE(p_quantity, 1);
    -- Cancelling needs no product; the client cancels with a NULL sku.
    IF v_sku IS NULL AND p_enabled THEN RETURN jsonb_build_object('success', false, 'error', 'sku_required'); END IF;
  ELSE
    SELECT * INTO v_purchase FROM public.ca_commerce_purchases WHERE id = v_ent.purchase_id;
    -- Only the original payer authorizes their own diamonds; a sponsored
    -- right renews through a new sponsor purchase, never a mandate.
    IF v_purchase.payer_id <> v_actor OR v_purchase.sponsorship_id IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'payer_required');
    END IF;
    v_sku := COALESCE(p_sku, v_ent.sku);
    v_quantity := COALESCE(p_quantity, v_ent.quantity);
  END IF;
  IF p_enabled THEN
    SELECT * INTO v_product FROM public.ca_commerce_products WHERE sku = v_sku;
    IF v_product.sku IS NULL OR NOT v_product.supported OR v_product.scope_kind <> v_ent.scope_kind OR v_product.term_kind <> 'period' THEN
      RETURN jsonb_build_object('success', false, 'error', 'sku_not_available');
    END IF;
    IF v_quantity < 1 OR v_quantity > 500 OR (v_product.quantity_unit = 'flat' AND v_quantity <> 1) THEN
      RETURN jsonb_build_object('success', false, 'error', 'quantity_out_of_range');
    END IF;
  END IF;
  -- The right's one mandate, whatever product it currently names.
  SELECT * INTO v_mandate FROM public.ca_commerce_renewal_mandates WHERE entitlement_id = v_ent.id FOR UPDATE;
  IF p_enabled THEN
    IF p_max_diamonds IS NULL OR p_max_diamonds < 0 OR p_max_diamonds > 2147483647 THEN
      RETURN jsonb_build_object('success', false, 'error', 'max_diamonds_required');
    END IF;
    IF v_mandate.id IS NULL THEN
      INSERT INTO public.ca_commerce_renewal_mandates (entitlement_id, scope_kind, scope_id, payer_id, sku, quantity, max_diamonds, due_at, accepted_by)
      VALUES (v_ent.id, v_ent.scope_kind, v_ent.scope_id, v_actor, v_sku, v_quantity, p_max_diamonds, v_ent.ends_at, v_actor)
      RETURNING * INTO v_mandate;
    ELSIF v_mandate.state = 'completed' THEN
      RETURN jsonb_build_object('success', false, 'error', 'period_already_renewed');
    ELSE
      UPDATE public.ca_commerce_renewal_mandates
         SET state = 'authorized', sku = v_sku, max_diamonds = p_max_diamonds, quantity = v_quantity, payer_id = v_actor, accepted_by = v_actor, accepted_at = now(),
             cancelled_at = NULL, cancelled_by = NULL, updated_at = now()
       WHERE id = v_mandate.id RETURNING * INTO v_mandate;
    END IF;
  ELSE
    IF v_mandate.id IS NULL THEN
      RETURN jsonb_build_object('success', true, 'state', 'none');
    END IF;
    IF v_mandate.state = 'completed' THEN
      RETURN jsonb_build_object('success', true, 'state', 'completed', 'note', 'This Period Was Already Renewed; Cancel The New Period Instead');
    END IF;
    UPDATE public.ca_commerce_renewal_mandates SET state = 'cancelled', cancelled_at = now(), cancelled_by = v_actor, updated_at = now()
     WHERE id = v_mandate.id RETURNING * INTO v_mandate;
  END IF;
  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('renewal_mandate_' || v_mandate.state, v_actor, v_ent.scope_kind, v_ent.scope_id, v_mandate.id, jsonb_build_object('sku', v_mandate.sku, 'max_diamonds', v_mandate.max_diamonds, 'due_at', v_mandate.due_at));
  RETURN jsonb_build_object('success', true, 'mandate_id', v_mandate.id, 'state', v_mandate.state, 'sku', v_mandate.sku, 'max_diamonds', v_mandate.max_diamonds, 'due_at', v_mandate.due_at);
END $$;

CREATE OR REPLACE FUNCTION public.fn_ca_commerce_execute_renewal(p_mandate_id uuid, p_lease_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_m public.ca_commerce_renewal_mandates;
  v_ent public.ca_commerce_entitlements;
  v_settings public.ca_commerce_settings;
  v_price public.ca_commerce_price_versions;
  v_product public.ca_commerce_products;
  v_gross integer;
  v_quote jsonb;
  v_result jsonb;
  v_now timestamptz := now();
  v_owner uuid;
  v_receipt_url text;
  v_detail text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Service Role Required';
  END IF;
  -- Lock order is scope, then mandate, on every path: purchase (upgrade) and
  -- refund take the scope lock before they touch a mandate row, so taking the
  -- mandate first here could deadlock against them. A mandate's scope never
  -- changes (an upgrade moves its right, not its scope), so the unlocked read
  -- that names the scope is exact.
  SELECT * INTO v_m FROM public.ca_commerce_renewal_mandates WHERE id = p_mandate_id;
  IF v_m.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'lease_lost');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_scope:' || v_m.scope_kind || ':' || v_m.scope_id::text, 0));
  SELECT * INTO v_m FROM public.ca_commerce_renewal_mandates WHERE id = p_mandate_id FOR UPDATE;
  IF v_m.id IS NULL OR v_m.lease_token IS DISTINCT FROM p_lease_token OR v_m.lease_until < clock_timestamp() THEN
    RETURN jsonb_build_object('success', false, 'error', 'lease_lost');
  END IF;
  IF v_m.state <> 'authorized' THEN
    RETURN jsonb_build_object('success', false, 'error', 'mandate_' || v_m.state);
  END IF;
  SELECT * INTO v_settings FROM public.ca_commerce_settings WHERE id = 1;
  SELECT * INTO v_ent FROM public.ca_commerce_entitlements WHERE id = v_m.entitlement_id;
  v_owner := public.fn_ca_commerce_scope_owner(v_m.scope_kind, v_m.scope_id);
  v_receipt_url := '/hub/club-arena/' || v_m.scope_kind || 's/' || v_m.scope_id::text || '/diamond-costs';

  -- Attention states: ownership moved, the right was revoked or superseded,
  -- or the due period lapsed beyond the accepted lateness treatment.
  IF v_ent.id IS NULL OR v_ent.state <> 'effective' OR v_owner IS DISTINCT FROM v_m.payer_id THEN
    v_result := jsonb_build_object('outcome', 'needs_attention', 'reason', 'payer_no_longer_owner_or_right_changed', 'at', v_now);
  ELSIF v_now > v_m.due_at + make_interval(hours => v_settings.renewal_lateness_hours) THEN
    v_result := jsonb_build_object('outcome', 'needs_attention', 'reason', 'lapsed_beyond_lateness_policy', 'due_at', v_m.due_at, 'at', v_now);
  ELSE
    SELECT * INTO v_product FROM public.ca_commerce_products WHERE sku = v_m.sku;
    SELECT * INTO v_price FROM public.ca_commerce_price_versions v
     WHERE v.sku = v_m.sku AND v.status = 'published' AND v.effective_from <= v_now AND (v.effective_to IS NULL OR v.effective_to > v_now);
    IF v_price.id IS NULL OR NOT v_product.supported THEN
      v_result := jsonb_build_object('outcome', 'needs_attention', 'reason', 'no_published_price', 'at', v_now);
    ELSE
      v_gross := public.fn_ca_commerce_line_gross(v_price, v_m.quantity);
      IF v_gross > v_m.max_diamonds THEN
        v_result := jsonb_build_object('outcome', 'needs_attention', 'reason', 'price_above_accepted_ceiling', 'price', v_gross, 'max_diamonds', v_m.max_diamonds, 'at', v_now);
      ELSE
        -- A system quote for exactly the due period, then the same atomic
        -- purchase boundary with the mandate as its request identity.
        v_quote := public.fn_ca_commerce_quote_impl(v_m.payer_id, v_m.payer_id, v_m.scope_kind, v_m.scope_id,
          jsonb_build_array(jsonb_build_object('sku', v_m.sku, 'quantity', v_m.quantity)), NULL, v_m.max_diamonds, 'renewal');
        IF NOT COALESCE((v_quote->>'success')::boolean, false) THEN
          v_result := jsonb_build_object('outcome', 'needs_attention', 'reason', COALESCE(v_quote->>'error', 'quote_failed'), 'at', v_now);
        ELSIF (v_quote->'lines'->0->>'starts_at')::timestamptz IS DISTINCT FROM v_ent.ends_at THEN
          -- The mandate authorizes exactly the period that begins where its
          -- right ends. When another right already covers that instant (a
          -- manual prepaid period, or a second standing mandate), the quote
          -- lands on a later period: charging now would bill a period that
          -- has not begun and was never the one authorized.
          UPDATE public.ca_commerce_quotes SET status = 'withdrawn' WHERE id = (v_quote->>'quote_id')::uuid AND status = 'open';
          v_result := jsonb_build_object('outcome', 'needs_attention', 'reason', 'period_already_covered',
            'due_period_start', v_ent.ends_at, 'quoted_start', v_quote->'lines'->0->'starts_at', 'at', v_now);
        ELSE
          BEGIN
            v_result := public.fn_ca_commerce_purchase_impl(v_m.payer_id, (v_quote->>'quote_id')::uuid, 'renewal:' || v_m.id::text || ':' || v_m.due_at::text, 'renewal');
          EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
            IF SQLERRM = 'CA_COMMERCE_INSUFFICIENT_DIAMONDS' THEN
              v_result := jsonb_build_object('success', false, 'error', 'insufficient_diamonds', 'balance', v_detail);
            ELSIF SQLERRM LIKE 'CA_COMMERCE_%' THEN
              v_result := jsonb_build_object('success', false, 'error', lower(replace(SQLERRM, 'CA_COMMERCE_', '')), 'detail', v_detail);
            ELSIF SQLSTATE = '23514' THEN
              v_result := jsonb_build_object('success', false, 'error', 'reserved_diamonds', 'detail', SQLERRM);
            ELSE
              RAISE;
            END IF;
          END;
          UPDATE public.ca_commerce_quotes SET status = 'withdrawn' WHERE id = (v_quote->>'quote_id')::uuid AND status = 'open';
          IF COALESCE((v_result->>'success')::boolean, false) THEN
            v_result := jsonb_build_object('outcome', 'renewed', 'purchase_id', v_result->>'purchase_id', 'charged', v_result->>'charged_this_attempt', 'at', v_now);
          ELSE
            v_result := jsonb_build_object('outcome', 'needs_attention', 'reason', COALESCE(v_result->>'error', 'purchase_failed'), 'detail', v_result->>'balance', 'at', v_now);
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;

  IF v_result->>'outcome' = 'renewed' THEN
    UPDATE public.ca_commerce_renewal_mandates SET state = 'completed', renewal_purchase_id = (v_result->>'purchase_id')::uuid, last_result = v_result, lease_token = NULL, lease_until = NULL, updated_at = now() WHERE id = v_m.id;
    -- The authorization carries forward to the new period at the same
    -- ceiling, so a standing renewal keeps standing until cancelled (D09).
    INSERT INTO public.ca_commerce_renewal_mandates (entitlement_id, scope_kind, scope_id, payer_id, sku, quantity, max_diamonds, due_at, accepted_by, accepted_at)
    SELECT e.id, e.scope_kind, e.scope_id, v_m.payer_id, v_m.sku, v_m.quantity, v_m.max_diamonds, e.ends_at, v_m.accepted_by, v_m.accepted_at
      FROM public.ca_commerce_entitlements e
     WHERE e.purchase_id = (v_result->>'purchase_id')::uuid AND e.sku = v_m.sku AND e.state = 'effective'
    ON CONFLICT (entitlement_id) DO NOTHING;
  ELSE
    UPDATE public.ca_commerce_renewal_mandates SET state = 'needs_attention', last_result = v_result, lease_token = NULL, lease_until = NULL, updated_at = now() WHERE id = v_m.id;
    -- One notice per failed attempt (attempts counts claims), so a mandate
    -- re-authorized after an earlier failure is still told when it fails again.
    PERFORM public.fn_ca_commerce_notice(v_m.payer_id, 'renewal-attention:' || v_m.id::text || ':' || v_m.attempts::text, 'club_commerce_renewal_attention',
      'Renewal Not Completed',
      'Your Diamond Renewal For ' || COALESCE((SELECT p.title FROM public.ca_commerce_products p WHERE p.sku = v_m.sku), 'This Service')
        || ' Was Not Completed (' || initcap(replace(COALESCE(v_result->>'reason', 'unknown'), '_', ' ')) || '). Current Paid Access Is Unchanged.',
      v_receipt_url, v_result);
  END IF;
  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('renewal_' || (v_result->>'outcome'), NULL, v_m.scope_kind, v_m.scope_id, v_m.id, v_result);
  RETURN jsonb_build_object('success', true) || v_result;
END $$;

CREATE OR REPLACE FUNCTION public.fn_ca_commerce_sponsorship_set(p_union_id uuid, p_club_id uuid, p_total_budget integer, p_per_club_budget integer, p_effective_to timestamptz, p_sponsorship_id uuid DEFAULT NULL, p_revoke boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_s public.ca_commerce_sponsorships;
BEGIN
  IF v_actor IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'authentication_required'); END IF;
  IF public.fn_ca_commerce_scope_role('union', p_union_id, v_actor) <> 'owner' THEN
    RETURN jsonb_build_object('success', false, 'error', 'union_owner_required');
  END IF;
  IF p_club_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id = p_club_id AND uc.union_id = p_union_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'club_not_in_union');
  END IF;
  IF p_sponsorship_id IS NOT NULL THEN
    SELECT * INTO v_s FROM public.ca_commerce_sponsorships WHERE id = p_sponsorship_id AND union_id = p_union_id FOR UPDATE;
    IF v_s.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'sponsorship_not_found'); END IF;
    IF p_revoke THEN
      UPDATE public.ca_commerce_sponsorships SET state = 'revoked', revoked_at = now(), revision = revision + 1 WHERE id = v_s.id RETURNING * INTO v_s;
    ELSE
      IF p_total_budget IS NULL OR p_total_budget < v_s.committed OR p_total_budget > 2147483647 THEN
        RETURN jsonb_build_object('success', false, 'error', 'budget_below_committed', 'committed', v_s.committed);
      END IF;
      UPDATE public.ca_commerce_sponsorships
         SET total_budget = p_total_budget, per_club_budget = p_per_club_budget, effective_to = p_effective_to, revision = revision + 1
       WHERE id = v_s.id RETURNING * INTO v_s;
    END IF;
  ELSE
    IF p_total_budget IS NULL OR p_total_budget <= 0 OR p_total_budget > 2147483647 THEN
      RETURN jsonb_build_object('success', false, 'error', 'budget_required');
    END IF;
    INSERT INTO public.ca_commerce_sponsorships (union_id, payer_id, club_id, total_budget, per_club_budget, effective_to, created_by)
    VALUES (p_union_id, v_actor, p_club_id, p_total_budget, p_per_club_budget, p_effective_to, v_actor)
    RETURNING * INTO v_s;
  END IF;
  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('sponsorship_' || v_s.state, v_actor, 'union', p_union_id, v_s.id, jsonb_build_object('club_id', v_s.club_id, 'total_budget', v_s.total_budget, 'per_club_budget', v_s.per_club_budget, 'revision', v_s.revision));
  RETURN jsonb_build_object('success', true, 'sponsorship_id', v_s.id, 'state', v_s.state, 'total_budget', v_s.total_budget, 'committed', v_s.committed, 'revision', v_s.revision);
END $$;

CREATE OR REPLACE FUNCTION public.fn_ca_commerce_refund(p_purchase_id uuid, p_line_index integer, p_amount integer, p_reason text, p_request_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_p public.ca_commerce_purchases;
  v_line jsonb;
  v_line_net integer;
  v_returned integer;
  v_credited integer;
  v_existing public.ca_commerce_refunds;
  v_ref text;
  v_credit jsonb;
  v_tx public.diamond_transactions;
  v_mint public.ca_mint_ledger;
  v_refund public.ca_commerce_refunds;
  v_refund_id uuid;
  v_detail text;
  v_ent public.ca_commerce_entitlements;
  v_restore jsonb := '[]'::jsonb;
  v_left integer;
  v_lot record;
  v_take integer;
  v_debt integer;
  v_full boolean;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  -- A refund credits the payer through add_diamonds_to_balance, and the
  -- profile wallet guard admits that write only from a service context or a
  -- named ledgered door. This door is not named there, so a staff member's
  -- browser session cannot complete a refund; say so in JSON before any
  -- work, instead of a raw 42501 from the guard mid-refund. Staff refunds go
  -- through a service-role route. Admitting this door in the guard is a
  -- permission change for the owner to make.
  -- The same test the guard applies, so this refuses exactly when it would.
  IF NOT public.fn_is_service_context() THEN
    RETURN jsonb_build_object('success', false, 'error', 'refund_requires_service_route');
  END IF;
  IF p_request_key IS NULL OR length(p_request_key) < 8 THEN
    RETURN jsonb_build_object('success', false, 'error', 'request_key_required');
  END IF;
  SELECT * INTO v_existing FROM public.ca_commerce_refunds WHERE request_key = p_request_key;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.purchase_id <> p_purchase_id OR v_existing.line_index <> p_line_index OR v_existing.gross <> p_amount THEN
      RETURN jsonb_build_object('success', false, 'error', 'request_key_reused');
    END IF;
    RETURN jsonb_build_object('success', true, 'is_replay', true, 'refund_id', v_existing.id, 'gross', v_existing.gross,
      'debt_settled', v_existing.debt_settled, 'net_increase', v_existing.net_increase, 'charged_this_attempt', 0);
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount_required');
  END IF;
  SELECT * INTO v_p FROM public.ca_commerce_purchases WHERE id = p_purchase_id;
  IF v_p.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'purchase_not_found'); END IF;
  -- Serialize by original purchase (D40).
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_refund:' || v_p.id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_scope:' || v_p.scope_kind || ':' || v_p.scope_id::text, 0));
  -- A concurrent request with the same key committed while this one waited
  -- for the lock: return its receipt instead of a key collision.
  SELECT * INTO v_existing FROM public.ca_commerce_refunds WHERE request_key = p_request_key;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.purchase_id <> p_purchase_id OR v_existing.line_index <> p_line_index OR v_existing.gross <> p_amount THEN
      RETURN jsonb_build_object('success', false, 'error', 'request_key_reused');
    END IF;
    RETURN jsonb_build_object('success', true, 'is_replay', true, 'refund_id', v_existing.id, 'gross', v_existing.gross,
      'debt_settled', v_existing.debt_settled, 'net_increase', v_existing.net_increase, 'charged_this_attempt', 0);
  END IF;
  v_line := (SELECT l FROM jsonb_array_elements(v_p.lines) l WHERE (l->>'index')::integer = p_line_index);
  IF v_line IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'line_not_found'); END IF;
  v_line_net := (v_line->>'net')::integer;
  SELECT COALESCE(SUM(r.gross), 0)::integer INTO v_returned FROM public.ca_commerce_refunds r WHERE r.purchase_id = v_p.id AND r.line_index = p_line_index;
  -- Unused value of this line already credited into an upgrade that
  -- replaced its right is spent: it cannot also come back as a refund (R2 6.4).
  SELECT COALESCE(SUM((l->>'credit')::integer), 0)::integer INTO v_credited
    FROM public.ca_commerce_entitlements e
    JOIN public.ca_commerce_entitlements n ON n.id = e.superseded_by
    JOIN public.ca_commerce_purchases u ON u.id = n.purchase_id
    CROSS JOIN LATERAL jsonb_array_elements(u.lines) l
   WHERE e.purchase_id = v_p.id AND e.line_index = p_line_index
     AND l->>'replaces_entitlement_id' = e.id::text;
  IF v_line_net = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'nothing_paid_on_this_line');
  END IF;
  IF p_amount > v_line_net - v_returned - v_credited THEN
    RETURN jsonb_build_object('success', false, 'error', 'exceeds_refundable', 'refundable', GREATEST(v_line_net - v_returned - v_credited, 0), 'credited_to_upgrade', v_credited);
  END IF;
  v_full := (v_returned + p_amount = v_line_net);
  v_refund_id := gen_random_uuid();
  v_ref := 'ca-commerce-refund:' || v_refund_id::text;
  -- The payer's wallet row first, as every canonical writer does.
  PERFORM 1 FROM public.profiles p WHERE p.id = v_p.payer_id FOR UPDATE;

  -- Exact-value door: 'refund' is in the multiplier exception list, is
  -- classified refund and registered as issuance by the existing origin rule.
  v_credit := public.add_diamonds_to_balance(v_p.payer_id, p_amount, 'refund',
    'Club And Union Diamond Costs Refund: ' || left(p_reason, 120), v_ref);
  IF NOT COALESCE((v_credit->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'CA_COMMERCE_REFUND_REFUSED' USING DETAIL = COALESCE(v_credit->>'error', 'unknown');
  END IF;
  IF COALESCE((v_credit->>'amount')::integer, -1) <> p_amount THEN
    RAISE EXCEPTION 'CA_COMMERCE_REFUND_NOT_EXACT' USING DETAIL = COALESCE(v_credit->>'amount', 'null');
  END IF;
  SELECT * INTO v_tx FROM public.diamond_transactions t WHERE t.user_id = v_p.payer_id AND t.reference_id = v_ref;
  IF v_tx.id IS NULL OR v_tx.amount <> p_amount OR v_tx.issuance_class <> 'refund' THEN
    RAISE EXCEPTION 'CA_COMMERCE_REFUND_JOURNAL_UNPROVED' USING DETAIL = v_ref;
  END IF;
  SELECT * INTO v_mint FROM public.ca_mint_ledger m WHERE m.diamond_tx_id = v_tx.id;
  IF v_mint.id IS NULL OR v_mint.action <> 'mint' OR v_mint.asset <> 'diamonds' OR v_mint.amount <> p_amount THEN
    RAISE EXCEPTION 'CA_COMMERCE_REFUND_REGISTER_UNPROVED' USING DETAIL = v_ref;
  END IF;
  v_debt := COALESCE((v_credit->>'debt_settled')::integer, 0);

  -- Restore operation-linked lot provenance, bounded by what this purchase
  -- consumed and by each lot's present consumed figure (D39, D65).
  v_left := p_amount;
  FOR v_lot IN SELECT (a->>'lot_id')::uuid AS lot_id, (a->>'consumed_delta')::integer AS delta FROM jsonb_array_elements(v_p.lot_allocation) a ORDER BY 1 LOOP
    EXIT WHEN v_left <= 0;
    SELECT LEAST(v_left, v_lot.delta - COALESCE((SELECT SUM((x->>'restored')::integer) FROM public.ca_commerce_refunds r, jsonb_array_elements(r.lot_restoration) x WHERE r.purchase_id = v_p.id AND x->>'lot_id' = v_lot.lot_id::text), 0), l.consumed)
      INTO v_take FROM public.diamond_purchase_lots l WHERE l.id = v_lot.lot_id FOR UPDATE;
    IF v_take IS NULL OR v_take <= 0 THEN CONTINUE; END IF;
    UPDATE public.diamond_purchase_lots SET consumed = consumed - v_take WHERE id = v_lot.lot_id;
    v_restore := v_restore || jsonb_build_object('lot_id', v_lot.lot_id, 'restored', v_take);
    v_left := v_left - v_take;
  END LOOP;

  INSERT INTO public.ca_commerce_refunds (id, purchase_id, line_index, request_key, requested_by, reason, payer_id, gross, debt_settled, net_increase, diamond_tx_id, mint_op_id, lot_restoration, revoked_entitlement)
  VALUES (v_refund_id, v_p.id, p_line_index, p_request_key, COALESCE(v_actor, v_p.payer_id), p_reason, v_p.payer_id, p_amount, v_debt, p_amount - v_debt, v_tx.id, v_mint.op_id, v_restore, v_full)
  RETURNING * INTO v_refund;

  IF v_full THEN
    UPDATE public.ca_commerce_entitlements SET state = 'revoked', updated_at = now() WHERE purchase_id = v_p.id AND line_index = p_line_index AND state = 'effective' RETURNING * INTO v_ent;
    UPDATE public.ca_commerce_renewal_mandates SET state = 'cancelled', cancelled_at = now(), updated_at = now() WHERE entitlement_id = v_ent.id AND state = 'authorized';
  END IF;
  IF v_p.sponsorship_id IS NOT NULL THEN
    UPDATE public.ca_commerce_sponsorships SET committed = GREATEST(committed - p_amount, 0) WHERE id = v_p.sponsorship_id;
  END IF;

  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('refund_committed', v_actor, v_p.scope_kind, v_p.scope_id, v_refund.id, jsonb_build_object('purchase_id', v_p.id, 'line_index', p_line_index, 'gross', p_amount, 'debt_settled', v_debt, 'net_increase', p_amount - v_debt, 'full', v_full));
  PERFORM public.fn_ca_commerce_notice(v_p.payer_id, 'refund:' || v_refund.id::text, 'club_commerce_refund',
    'Refund: ' || p_amount::text || ' Diamonds',
    'Refund: ' || p_amount::text || ' Diamonds; Applied To Existing Debt: ' || v_debt::text || '; Added To Available Balance: ' || (p_amount - v_debt)::text || '.',
    '/hub/club-arena/' || v_p.scope_kind || 's/' || v_p.scope_id::text || '/diamond-costs', jsonb_build_object('refund_id', v_refund.id));

  RETURN jsonb_build_object('success', true, 'is_replay', false, 'refund_id', v_refund.id, 'gross', p_amount, 'debt_settled', v_debt,
    'net_increase', p_amount - v_debt, 'diamond_tx_id', v_tx.id, 'mint_op_id', v_mint.op_id, 'lot_restoration', v_restore, 'entitlement_revoked', v_full);
EXCEPTION
  WHEN OTHERS THEN
    -- Every write above rolled back, so nothing was credited and nothing is
    -- credited twice on a retry. A refund the wallet cannot receive yet
    -- (balance headroom, D64) is refused whole; the same request key can be
    -- retried once the wallet has room. The owed amount remains provable
    -- from the original receipt and the absence of a refund row.
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF SQLERRM LIKE 'CA_COMMERCE_%' THEN
      RETURN jsonb_build_object('success', false, 'error', lower(replace(SQLERRM, 'CA_COMMERCE_', '')), 'detail', v_detail, 'retry_same_request_key', true);
    END IF;
    IF SQLSTATE = '23514' THEN
      RETURN jsonb_build_object('success', false, 'error', 'wallet_cannot_receive_yet', 'detail', SQLERRM, 'retry_same_request_key', true);
    END IF;
    RAISE;
END $$;

CREATE OR REPLACE FUNCTION public.fn_ca_commerce_price_publish(p_price_version_id uuid, p_effective_from timestamptz DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_v public.ca_commerce_price_versions;
  v_from timestamptz := COALESCE(p_effective_from, now());
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  -- A published price names its publisher (the version trigger refuses a
  -- NULL one); a service-role call carries no person, so say so in JSON.
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'publisher_required');
  END IF;
  SELECT * INTO v_v FROM public.ca_commerce_price_versions WHERE id = p_price_version_id FOR UPDATE;
  IF v_v.id IS NULL OR v_v.status <> 'validated' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_validated');
  END IF;
  IF v_from < now() - interval '1 minute' THEN
    RETURN jsonb_build_object('success', false, 'error', 'price_changes_are_prospective');
  END IF;
  -- The current published price retires at the new effective date; accepted
  -- purchases keep their price version (D74). A prospective publication
  -- leaves the current price published and in effect until v_from (no gap
  -- with no price); a published version that would only have started at or
  -- after v_from never takes effect and retires whole.
  UPDATE public.ca_commerce_price_versions
     SET status = CASE WHEN v_from <= now() OR effective_from >= v_from THEN 'retired' ELSE status END,
         effective_to = CASE WHEN effective_from >= v_from THEN effective_to ELSE v_from END
   WHERE sku = v_v.sku AND status = 'published' AND (effective_to IS NULL OR effective_to > v_from);
  UPDATE public.ca_commerce_price_versions SET status = 'published', effective_from = v_from, published_by = v_actor, published_at = now() WHERE id = v_v.id;
  INSERT INTO public.ca_commerce_events (kind, actor_id, reference_id, detail) VALUES ('price_published', v_actor, v_v.id, jsonb_build_object('sku', v_v.sku, 'version', v_v.version, 'effective_from', v_from));
  RETURN jsonb_build_object('success', true, 'price_version_id', v_v.id, 'effective_from', v_from);
END $$;

-- ---------------------------------------------------------------------------
-- Post-conditions.
-- ---------------------------------------------------------------------------
DO $assertions$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.ca_commerce_renewal_mandates'::regclass
                  AND conname = 'ca_commerce_renewal_mandates_entitlement_id_key' AND contype = 'u') THEN
    RAISE EXCEPTION 'one mandate per right is not enforced';
  END IF;
  IF strpos((SELECT prosrc FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'fn_ca_commerce_execute_renewal'),
            'ca_commerce_scope:') = 0 THEN
    RAISE EXCEPTION 'renewal execution does not take the scope lock first';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_ca_commerce_execute_renewal(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_commerce_purchase_impl(uuid,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'commerce internal doors must stay private';
  END IF;
END $assertions$;

COMMIT;
