-- 20261003082051_the_witness_audit_knows_the_dead_button
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-03 08:20:51 UTC.
--
-- THE WITNESS AUDIT KNOWS THE DEAD BUTTON (2026-10-03)
--
-- StatsWitnessAuditDisagrees has fired continuously: ca_stats_witness_audit
-- logged 7-140 button disagreements an hour for the last 30 hours (about 0.2%
-- of hands). The audit derives the button as the dealt seat directly before
-- the small-blind poster. Since 2026-09-25 the engine applies TDA Rule 30
-- (server/src/engine/deadButton.ts, DeadButtonEveryTableSize.test.ts): when
-- the player who should take the button has left, the button stays on that
-- EMPTY seat, between the last live seat and the small blind. hand_history
-- records that seat correctly, and the audit, which only sees dealt seats,
-- calls it a disagreement.
--
-- Measured on production 2026-10-03 08:15 UTC over the hour of hands to
-- 08:00: 87 disagreements, and 87 of 87 had a stored button on a seat no
-- player was dealt in, strictly inside that gap (3- to 8-handed). Not one
-- was a stored button on a dealt seat. This is an audit defect, not a
-- recording defect; the engine is right.
--
-- The audit now skips exactly that case: more than two dealt seats, the
-- stored button on an undealt seat, strictly between the derived seat and
-- the small blind in seat order. A stored button on a dealt seat, outside
-- the gap, or NULL still counts, and nothing else in the audit moves.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261003025434. The
-- live text must hash to that file's postimage (fbea24b8...), each anchor
-- must occur exactly once, and the result must hash to the derived postimage
-- (computed read-only on production); owner, SECURITY DEFINER, proconfig and
-- grants must not move.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.ca_stats_witness_audit(integer,integer)'::regprocedure)) = '0260f227fb49030f22a7e2019a755796')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
                                       p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

SELECT pg_temp.ca_audit_subst(
  'public.ca_stats_witness_audit(integer,integer)',
  'fbea24b80e755d047b6177b0c1f1fd56', '0260f227fb49030f22a7e2019a755796',
  ARRAY[$o1$SELECT h.id, h.stored, sm.n, (p.sb_seat IS NOT NULL) AS has_posts,$o1$,
        $o2$count(*) FILTER (WHERE has_posts AND derived IS DISTINCT FROM stored)::int$o2$],
  ARRAY[$n1$SELECT h.id, h.stored, sm.n, sm.seats, p.sb_seat, (p.sb_seat IS NOT NULL) AS has_posts,$n1$,
        $n2$count(*) FILTER (WHERE has_posts AND derived IS DISTINCT FROM stored
           -- A DEAD BUTTON IS NOT A DISAGREEMENT (2026-10-03). Since the
           -- engine applies TDA Rule 30 (server/src/engine/deadButton.ts,
           -- 2026-09-25) the button can rest on a seat its player has left:
           -- an empty seat strictly between the last live seat before the
           -- small blind and the small blind. That is the correct button and
           -- the derivation above cannot name it, because it only knows the
           -- seats dealt in. Every one of 87 disagreements in an hour measured
           -- on production was this case. A stored button on a dealt seat, or
           -- anywhere outside that gap, still counts.
           AND NOT (n > 2 AND derived IS NOT NULL AND stored IS NOT NULL
                    AND NOT (stored = ANY (seats))
                    AND CASE WHEN derived < sb_seat
                             THEN stored > derived AND stored < sb_seat
                             ELSE stored > derived OR stored < sb_seat END))::int$n2$]
);

COMMIT;
