-- ═══════════════════════════════════════════════════════════════════════════
-- A CLAIM CANNOT DESTROY CHIPS, AND MONEY NOBODY CAN REACH IS NOT INVISIBLE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Found by reading `fn_agent_claim_commission` line by line after the phase 7
-- work landed. Two defects and one measurement.
--
-- ── 1. THE CLAIM COULD DEBIT THE BANK AND CREDIT NOBODY ─────────────────────
--
-- The function reads the caller's club_members row for their role, WITHOUT
-- FOR UPDATE, and then ~90 lines later does:
--
--     UPDATE club_members SET chip_balance = ... WHERE club_id = ... AND
--       user_id = v_actor RETURNING chip_balance INTO v_to_after;
--
-- and never checks that it matched. Between the two, the clubs row is locked
-- and debited. So if that membership row is deleted in the window - somebody
-- leaves the club, an owner removes them, a cleanup runs - the sequence is:
--
--     treasury  -= amount        (committed)
--     wallet    += amount        (matched NOTHING, silently)
--     settled_at = now()         (rows marked paid)
--
-- The chips leave the club treasury and land nowhere, and the ledger row
-- records a payment that did not happen. That is precisely the failure class
-- CLAUDE.md 11.5 was written after ("chips cannot leave the felt unnoticed"),
-- and unlike the seat case there is no trigger watching this one.
--
-- Two changes, both narrowing:
--   a. the role read takes FOR UPDATE, so the row cannot vanish mid-claim;
--   b. the credit asserts it matched, and RAISES if it did not - which rolls
--      the whole claim back, bank included, rather than committing a hole.
--
-- Nothing else about the function moves. The refusal ORDER that the original
-- author was careful about (every write after the last thing that can refuse)
-- is preserved: (b) is not a refusal, it is an abort, and it can only fire on
-- a state that should be impossible.
--
-- ── 2. 643.43 CHIPS ARE OWED TO PAYEES WHO CANNOT CLAIM THEM ────────────────
--
-- Measured on production 2026-09-02: 79 (club, user) pairs hold unsettled
-- commission and have NO club_members row in the club it is booked to, so
-- `fn_agent_claim_commission` refuses them at the membership check - correctly,
-- since it pays into club_members.chip_balance, which they do not have. All 79
-- are horses, and under CLAUDE.md 10.5 a horse is paid everything a human is
-- paid, so this is money owed and unreachable, not money that does not exist.
--
-- It is still growing: 2 of 17,411 rows in the last six hours, ~11 chips a day,
-- across 2 clubs.
--
-- THE CAUSE is the second lookup in `credit_agent_commission_from_rake`:
--
--     -- The caller may itself be an agent generating rake.
--     IF v_agent_id IS NULL THEN
--       SELECT ... FROM agents WHERE user_id = p_agent_user_id AND status = 'active'
--        ORDER BY (club_id = v_book_club) DESC LIMIT 1;
--     END IF;
--
-- The first lookup is correctly scoped to the booking club (it joins
-- club_members on cm.club_id = v_book_club). This fallback is scoped to NO
-- club at all: it finds the user's agents row in ANY club, and the INSERT then
-- books the commission to `v_book_club` - a club that row has nothing to do
-- with, and that the payee may not be a member of.
--
-- THIS MIGRATION DOES NOT CHANGE THAT LOOKUP. Narrowing it decides who earns
-- money, and that is Dan's call, not an agent's - CLAUDE.md 10.5 exists
-- because I once wrote an earnings exclusion on my own assumption and reported
-- the resulting zero as correct behaviour. The two ways forward have different
-- owners of the same chips, and Dan picks:
--
--   A. scope the fallback to v_book_club. Nothing accrues where it cannot be
--      claimed; that rake stays with the club, as it already does for any
--      non-agent. The 643.43 already accrued still needs a home.
--   B. book to the club the agents row actually lives in, so the payee can
--      claim it where they are a member. Changes union-law money routing.
--
-- What this migration does instead is make it VISIBLE, which the horses law
-- requires on its own terms: money owed to a horse is "NEVER silently filtered
-- out of a report, a total, or a ledger". `fn_club_unclaimable_commission`
-- reports it per club, and with no argument reports the whole estate.
--
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
--   DROP FUNCTION IF EXISTS public.fn_club_unclaimable_commission(uuid);
--   -- and in fn_agent_claim_commission, drop " FOR UPDATE" from the role read
--   -- and delete the IF v_to_after IS NULL block. Do not: it is the only thing
--   -- stopping a debited bank from crediting nobody.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── The claim patch ─────────────────────────────────────────────────────────
--
-- Patched, never re-emitted: this function is 9 KB of carefully ordered money
-- handling and several agents ship into it. Each replacement asserts it found
-- exactly one occurrence, so a drifted source refuses rather than guesses.
DO $patch$
DECLARE
  v_src   text;
  v_args  text;
  v_role_old text :=
    '     AND COALESCE(cm.status, ''active'') IN (''active'', ''approved'');';
  v_role_new text :=
    '     AND COALESCE(cm.status, ''active'') IN (''active'', ''approved'')' || E'\n' ||
    '     -- FOR UPDATE, added 2026-09-02. Without it this row can be deleted' || E'\n' ||
    '     -- between here and the credit ninety lines below, and the credit' || E'\n' ||
    '     -- silently matches nothing while the bank has already been debited.' || E'\n' ||
    '     FOR UPDATE;';
  v_credit_old text := '   RETURNING chip_balance INTO v_to_after;';
  v_credit_new text :=
    '   RETURNING chip_balance INTO v_to_after;' || E'\n' ||
    E'\n' ||
    '  -- THE CREDIT MUST HAVE LANDED. The bank is already debited at this' || E'\n' ||
    '  -- point, so a credit that matched no row would leave the chips nowhere' || E'\n' ||
    '  -- and stamp the rows paid. The role read above holds FOR UPDATE, so' || E'\n' ||
    '  -- this should be unreachable; RAISE rather than RETURN because a' || E'\n' ||
    '  -- refusal here has to take the debit back with it, and only an' || E'\n' ||
    '  -- exception rolls back what PostgREST would otherwise commit.' || E'\n' ||
    '  IF v_to_after IS NULL THEN' || E'\n' ||
    '    RAISE EXCEPTION ''commission claim could not credit the member wallet''' || E'\n' ||
    '      USING ERRCODE = ''25000'';' || E'\n' ||
    '  END IF;';
  v_hits int;
BEGIN
  SELECT p.prosrc, pg_get_function_arguments(p.oid)
    INTO v_src, v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_agent_claim_commission';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_agent_claim_commission does not exist; refusing to guess';
  END IF;

  IF position('commission claim could not credit the member wallet' IN v_src) > 0 THEN
    RAISE NOTICE 'fn_agent_claim_commission already carries both guards; skipping';
    RETURN;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, v_role_old, ''))) / length(v_role_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 membership read in fn_agent_claim_commission, found %', v_hits;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, v_credit_old, ''))) / length(v_credit_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 wallet credit in fn_agent_claim_commission, found %', v_hits;
  END IF;

  v_src := replace(v_src, v_role_old, v_role_new);
  v_src := replace(v_src, v_credit_old, v_credit_new);

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.fn_agent_claim_commission(%s) RETURNS jsonb '
    'LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'' AS %L',
    v_args, v_src);

  RAISE NOTICE 'fn_agent_claim_commission: membership locked, credit asserted';
END
$patch$;

-- ── The claim's own grants, written down ────────────────────────────────────
--
-- check-definer-authorization BLOCKED this migration, and it was right to.
-- The patch above declares fn_agent_claim_commission through EXECUTE format(),
-- so the body never appears literally in this file - and a static scan
-- therefore sees a SECURITY DEFINER function declared here that never calls
-- auth.uid(). It does call it, on its third statement, and it is the first
-- thing it does; but a checker cannot know that, and "trust me, the body is
-- fine" is exactly the claim the check exists to refuse.
--
-- These four lines are the remedy the gate asks for, and they change nothing:
-- verified against production before writing them, anon = false,
-- authenticated = true, service_role = true. They make the state explicit
-- rather than inherited, which is what every other migration in this family
-- now does.
REVOKE ALL ON FUNCTION public.fn_agent_claim_commission(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_agent_claim_commission(uuid, uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_agent_claim_commission(uuid, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_agent_claim_commission(uuid, uuid, integer) TO service_role;

-- ── The report ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_club_unclaimable_commission(
  p_club_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  -- Unsettled commission booked to a club the payee is not an active member
  -- of. fn_agent_claim_commission refuses these at the membership check, so
  -- the money is owed and unreachable until somebody acts on it. Horses are
  -- included and counted: CLAUDE.md 10.5 - a horse is never silently filtered
  -- out of a report, a total or a ledger.
  SELECT jsonb_build_object(
           'pairs',      COALESCE(count(*), 0),
           'total',      COALESCE(round(sum(t.amt), 2), 0),
           'rows',       COALESCE(sum(t.n), 0),
           'clubs',      COALESCE(count(DISTINCT t.club_id), 0),
           'horses',     COALESCE(count(*) FILTER (WHERE t.is_horse), 0),
           'humans',     COALESCE(count(*) FILTER (WHERE NOT t.is_horse), 0),
           'still_accruing_24h',
                         COALESCE(count(*) FILTER (WHERE t.last_row > now() - interval '24 hours'), 0),
           'measured_at', now()
         )
    FROM (
      SELECT ac.club_id,
             ac.user_id,
             SUM(ac.amount)     AS amt,
             count(*)           AS n,
             max(ac.created_at) AS last_row,
             COALESCE((SELECT pr.is_horse FROM profiles pr WHERE pr.id = ac.user_id), false) AS is_horse
        FROM agent_commissions ac
       WHERE ac.settled_at IS NULL
         AND (p_club_id IS NULL OR ac.club_id = p_club_id)
         AND NOT EXISTS (
               SELECT 1 FROM club_members cm
                WHERE cm.club_id = ac.club_id
                  AND cm.user_id = ac.user_id
                  AND COALESCE(cm.status, 'active') IN ('active', 'approved'))
       GROUP BY ac.club_id, ac.user_id
    ) t;
$fn$;

-- REVOKE FROM authenticated EXPLICITLY. Supabase's default privileges grant
-- EXECUTE on every new function in `public` to anon AND authenticated, and
-- REVOKE ... FROM PUBLIC does not take those away - they are direct grants to
-- named roles, not the PUBLIC pseudo-role. The assertion at the bottom of this
-- migration caught exactly that on the first apply attempt, which is why it is
-- an assertion and not a comment.
REVOKE ALL ON FUNCTION public.fn_club_unclaimable_commission(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_club_unclaimable_commission(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_club_unclaimable_commission(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_unclaimable_commission(uuid) TO service_role;

COMMENT ON FUNCTION public.fn_club_unclaimable_commission(uuid) IS
  'Unsettled commission booked to a club the payee is not an active member of, so the claim path refuses it. SERVICE ROLE ONLY: it reports across clubs and has no per-caller guard. Horses are counted, never filtered (CLAUDE.md 10.5).';

-- ── Assertions ──────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_agent_claim_commission';

  IF position('IN (''active'', ''approved'')' || E'\n' IN v_src) = 0
     OR position('FOR UPDATE;' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_agent_claim_commission does not lock the membership row';
  END IF;
  IF position('commission claim could not credit the member wallet' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_agent_claim_commission does not assert the credit landed';
  END IF;
  -- The refusal order the original author protected must survive: the settle
  -- still has to come after the bank debit.
  IF position('UPDATE clubs' IN v_src) > position('UPDATE agent_commissions' IN v_src) THEN
    RAISE EXCEPTION 'the settle now runs before the bank debit; refusal order broken';
  END IF;

  IF has_function_privilege('authenticated',
       'public.fn_club_unclaimable_commission(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_club_unclaimable_commission must not be callable by authenticated';
  END IF;

  RAISE NOTICE 'a claim cannot destroy chips: applied and verified';
END
$verify$;
