-- 20260921052548_payee_documents_are_private_to_their_payee_and_rosters_are_n.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Three privacy defects found by real RLS evaluation (SET LOCAL ROLE
-- authenticated + request.jwt.claims inside BEGIN/ROLLBACK), not by a
-- service-role read. The owner's standing mandate is that a club receives one
-- weekly AGGREGATE and never an individual recipient's private document.
--
-- D1 - CONFIRMED LEAK. The restrictive gate fn_messenger_invoice_visible_to
--   demanded a personal delivery row only for an invoice that was
--   from_entity_type='club' AND to_entity_type IN('agent','player') AND
--   source_ledger_id IS NOT NULL AND breakdown->>'category' IN
--   ('rakeback','commission'). A union->player prize receipt
--   (crash_prize/mines_prize/wheel_prize/plinko_prize/crossing_prize) misses
--   every one of those conditions, so the restrictive gate let it through and
--   the permissive settlement_invoices_club_admin_select policy
--   (fn_is_platform_admin() OR fn_is_club_admin_uid(club_id)) then handed it to
--   any club admin. Measured on production 2026-09-21: club admin
--   7a13e69e-b2de-425b-b522-7edf204eaa4d - not a platform admin, not a union
--   overseer - read 11 invoices, 5 of them addressed to player
--   3bb71bfe-f723-427c-aac7-a853ba04a014 with that player's identity and the
--   exact amount, and zero delivery rows of his own. Platform-wide 20 of the
--   103 individual-addressed invoices fell outside the gate, all carrying
--   amounts, across 2 individuals.
--
--   The fix: WHO SENT a document, whether it carries a source_ledger_id, and
--   what category it names are not what makes it private. Being addressed to a
--   person is. The final arm now demands a personal 'immediate' delivery row
--   for EVERY invoice with to_entity_type IN('agent','player'), whatever the
--   sender, ledger link or category.
--
--   Verified before applying: all 20 of those invoices already carry an
--   'immediate' delivery row for their own payee, and the union overseer who
--   legitimately reads them carries one on all 20 as well - so no legitimate
--   reader loses anything. Club-level aggregates (to_entity_type IN
--   ('club','union'): union_weekly_squareup, union_to_club,
--   union_weekly_credit_note, union_club_pnl, club_weekly_accounting) are not
--   touched by this arm at all; all 12 of them stay exactly as visible as they
--   were. Everything else in the function - the credit_limit_change,
--   accounting_correction, cashier_cashout and unverified-correction arms and
--   the actor self-binding - is preserved byte for byte.
--
-- D2 - LATENT. rakeback_distributions_club_member_select was
--   fn_is_platform_admin() OR club_id IN (SELECT fn_my_club_ids()) - plain
--   MEMBERSHIP, not even admin. That table carries player_user_id,
--   player_rake_contributed, rakeback_percentage and rakeback_amount. It holds
--   0 rows today, so nothing leaks yet; the first write would publish every
--   member's rakeback summary to every co-member, which is precisely what the
--   mandate forbids. It is scoped here to the two parties of the row, matching
--   the pattern its siblings already use - rakeback_periods.rakeback_read and
--   rakeback_period_payouts 'users read own rakeback receipts' are both
--   user_id = auth.uid(). No club-level arm is added: nothing club-facing reads
--   this table. The club weekly AGGREGATE is served by
--   fn_club_weekly_accounting_summary, a SECURITY DEFINER reader that never
--   touches rakeback_distributions, and ClubWeeklyAccountingReader calls that
--   reader, not this table. Confirmed no reader in src/, server/src/ or the
--   World Hub's pages/ - the only reference anywhere is delete-club.js naming
--   the table for cascade deletion, which runs as service_role and so is
--   unaffected (service_role has BYPASSRLS).
--
-- D3 - ENUMERATION ORACLE. fn_accounting_party_users, fn_is_any_union_overseer,
--   fn_union_oversees_club and fn_is_union_overseer are SECURITY DEFINER,
--   EXECUTE-granted to authenticated, and did not bind their user parameter to
--   auth.uid(). Measured: unrelated user 34337d2d-5310-423d-8ae4-41a167fbb7c9,
--   with zero club memberships, called fn_accounting_party_users('club',
--   'a41434bb-...') and received 2 owner/admin UUIDs, ('union','fade...0001')
--   and received 1, and read another user's overseer status as true from all
--   three predicates. UUIDs only - roster enumeration, not bulk disclosure -
--   but unauthorized all the same.
--
--   Revoking EXECUTE was rejected: an RLS policy expression is evaluated with
--   the privileges of the role running the query, and every function named in
--   an `authenticated` policy on this database is EXECUTE-granted to
--   `authenticated` (checked: zero exceptions). Revoking would break 17
--   policies that call fn_is_any_union_overseer, 17 that call
--   fn_union_oversees_club and 3 that call fn_is_union_overseer.
--
--   So these self-bind instead, reusing the pattern fn_messenger_*_visible_to
--   already uses: a non-engine caller may only ask about itself. Every caller
--   was read first. All 17+17+3 policies and every internal caller pass
--   auth.uid() (v_uid/v_actor/actor are all `:= auth.uid()`), with one
--   exception: fn_accounting_party_users must decide overseer status for each
--   union_admins row it is asked to list, so it is repointed at
--   fn_union_overseer_of_record - the same body, no self-binding, EXECUTE
--   granted to postgres/service_role only, reachable from a browser session
--   solely through these SECURITY DEFINER bodies. fn_union_can_manage_wallets
--   takes a p_user_id and is left alone: its only third-party path is
--   fn_wheel_can_operate, and all ten of that function's callers
--   (fn_wheel_set_config/_metrics/_set_welcome_spin, fn_diamond_game_room/
--   _players/_pnl/_metrics/_set_config/_fund_promo, fn_diamond_spins_owner_terms)
--   pass `v_user uuid := auth.uid()`, while a service_role caller returns true
--   before that branch is reached.
--
--   fn_accounting_party_users takes no user parameter at all, so there is
--   nothing to self-bind; it is gated instead - the engine still sees the whole
--   roster, and a browser session sees it only if it is itself in that roster.
--   Every reader caller already filters the result to exactly that identity
--   (fn_club_weekly_accounting_summary `WHERE u.user_id=auth.uid()`,
--   fn_accounting_run_observation_v1 `WHERE p.user_id=actor` with actor
--   :=auth.uid() and asserted equal to its expected actor,
--   fn_messenger_private_weekly_summary `WHERE u.user_id=p_user_id` with
--   p_user_id already self-bound, and the union_accounting_runs_scoped_read
--   policy `WHERE p.user_id = auth.uid()`), so the truth value each of them
--   computes is unchanged. The three writer callers -
--   fn_accounting_correction_prepare, fn_deliver_accounting_invoice and
--   fn_issue_scope_weekly_accounting - are not EXECUTE-granted to
--   authenticated, run as service_role and keep the full roster through the
--   engine arm.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ---------------------------------------------------------------------------
-- D1. A document addressed to a person is private to that person, full stop.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_messenger_invoice_visible_to(p_invoice_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 IF p_user_id IS NULL OR (NOT public.fn_caller_is_engine() AND auth.uid() IS DISTINCT FROM p_user_id)
 THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM public.settlement_invoices i WHERE i.id=p_invoice_id
   AND (i.invoice_type<>'credit_limit_change' OR EXISTS(
    SELECT 1 FROM public.accounting_credit_change_documents_v1 cd
    JOIN public.accounting_invoice_deliveries d ON d.invoice_id=cd.invoice_id
     AND d.recipient_id=p_user_id AND d.delivery_mode='immediate'
    WHERE cd.invoice_id=i.id AND p_user_id=ANY(cd.audience_user_ids)
     AND public.fn_accounting_credit_change_contract_v1(i.id) IS NOT NULL))
   AND NOT public.fn_accounting_correction_is_unverified(i.id)
   AND (i.invoice_type<>'accounting_correction' OR EXISTS(SELECT 1 FROM public.accounting_correction_documents cd JOIN public.accounting_invoice_deliveries d ON d.invoice_id=cd.invoice_id AND d.recipient_id=p_user_id AND d.delivery_mode='immediate' WHERE cd.invoice_id=i.id AND p_user_id=ANY(cd.audience_user_ids)))
   AND (i.invoice_type<>'cashier_cashout' OR EXISTS(SELECT 1 FROM public.accounting_cashier_events ce
     WHERE ce.invoice_id=i.id AND p_user_id=ANY(ce.audience_user_ids)))
   -- Addressed to a person: the sender, the ledger link and the category are
   -- not what makes it private, so they are not asked about any more.
   AND (i.to_entity_type NOT IN('agent','player')
     OR EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d
       WHERE d.invoice_id=i.id AND d.recipient_id=p_user_id AND d.delivery_mode='immediate')));
END $function$;

-- ---------------------------------------------------------------------------
-- D2. A rakeback distribution row belongs to its payee and its paying agent.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS rakeback_distributions_club_member_select ON public.rakeback_distributions;
CREATE POLICY rakeback_distributions_party_select ON public.rakeback_distributions
  FOR SELECT TO authenticated
  USING (
    player_user_id = (SELECT auth.uid())
    OR agent_user_id = (SELECT auth.uid())
    OR (SELECT public.fn_is_platform_admin())
  );

-- ---------------------------------------------------------------------------
-- D3. The roster and overseer predicates answer only about their own caller.
-- ---------------------------------------------------------------------------

-- The unbound predicate, kept in one place so the two internal callers that
-- must evaluate a third party do not carry a second copy of this rule. Not
-- reachable from a browser: EXECUTE is postgres/service_role only.
CREATE OR REPLACE FUNCTION public.fn_union_overseer_of_record(p_union_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_union_id IS NOT NULL AND p_user_id IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.unions u WHERE u.id = p_union_id AND u.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.union_admins a WHERE a.union_id = p_union_id AND a.user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.clubs c
                WHERE c.id = p_union_id AND COALESCE(c.is_union, false) AND c.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.club_members m
                WHERE m.club_id = p_union_id AND m.user_id = p_user_id
                  AND m.role IN ('owner','co_owner','admin')
                  AND m.status IN ('active','approved'))
  );
$function$;
REVOKE ALL ON FUNCTION public.fn_union_overseer_of_record(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_overseer_of_record(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_is_union_overseer(p_union_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_user_id IS NOT NULL
     AND (public.fn_caller_is_engine() OR auth.uid() IS NOT DISTINCT FROM p_user_id)
     AND public.fn_union_overseer_of_record(p_union_id, p_user_id);
$function$;

CREATE OR REPLACE FUNCTION public.fn_is_any_union_overseer(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_user_id IS NOT NULL
     AND (public.fn_caller_is_engine() OR auth.uid() IS NOT DISTINCT FROM p_user_id)
     AND (
       EXISTS (SELECT 1 FROM unions u WHERE u.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM union_admins a WHERE a.user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM clubs c
                WHERE COALESCE(c.is_union, false) AND c.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM club_members m
                JOIN clubs c2 ON c2.id = m.club_id AND COALESCE(c2.is_union, false)
               WHERE m.user_id = p_user_id AND m.role IN ('owner','co_owner','admin')
                 AND m.status IN ('active','approved'))
  );
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_oversees_club(p_club_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_club_id IS NOT NULL AND p_user_id IS NOT NULL
     AND (public.fn_caller_is_engine() OR auth.uid() IS NOT DISTINCT FROM p_user_id)
     AND public.fn_union_overseer_of_record(
    COALESCE(
      (SELECT uc.union_id FROM public.union_clubs uc WHERE uc.club_id = p_club_id LIMIT 1),
      (SELECT c.union_id FROM public.clubs c WHERE c.id = p_club_id)
    ),
    p_user_id
  );
$function$;

-- No user parameter to bind: the engine keeps the whole roster, a browser
-- session is told only about a roster it is itself on.
CREATE OR REPLACE FUNCTION public.fn_accounting_party_users(p_kind text, p_id uuid)
 RETURNS TABLE(user_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 WITH party AS (
  SELECT DISTINCT p.id FROM public.profiles p WHERE p.id IN (
   SELECT p_id WHERE p_kind IN('agent','player')
   UNION SELECT c.owner_id FROM public.clubs c WHERE p_kind='club' AND c.id=p_id
   UNION SELECT m.user_id FROM public.club_members m WHERE p_kind='club' AND m.club_id=p_id
    AND m.role IN('owner','co_owner','admin') AND COALESCE(m.status,'active') IN('active','approved')
   UNION SELECT u.owner_id FROM public.unions u WHERE p_kind='union' AND u.id=p_id
   UNION SELECT a.user_id FROM public.union_admins a WHERE p_kind='union' AND a.union_id=p_id
    AND public.fn_union_overseer_of_record(p_id,a.user_id)
  )
 )
 SELECT party.id FROM party
 WHERE public.fn_caller_is_engine()
    OR EXISTS(SELECT 1 FROM party self WHERE self.id = auth.uid());
$function$;

COMMIT;
