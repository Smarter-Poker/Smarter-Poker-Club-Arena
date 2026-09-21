# A document addressed to a person is private to that person

2026-09-21. Three privacy defects in union accounting and rake back, found by
real RLS evaluation — `SET LOCAL ROLE authenticated` with
`request.jwt.claims` inside `BEGIN…ROLLBACK` — and not by a service-role read,
which would have shown nothing. Installed as `20260921052548`.

The owner's standing mandate: a club receives one weekly aggregate, a club must
not see an individual recipient's private rakeback transaction summary, and a
payee document stays private to its authorized audience.

## D1 — the confirmed leak

`settlement_invoices` has a permissive policy
`settlement_invoices_club_admin_select` = `fn_is_platform_admin() OR
fn_is_club_admin_uid(club_id)`, held in check by the restrictive gate
`fn_messenger_invoice_visible_to`. That gate demanded a personal delivery row
only when **all four** of these were true: `from_entity_type='club'`,
`to_entity_type IN('agent','player')`, `source_ledger_id IS NOT NULL`, and
`breakdown->>'category' IN('rakeback','commission')`.

A union→player prize receipt satisfies the second and third and neither of the
others. It therefore passed the restrictive gate untouched, and the permissive
policy then handed it to any club admin.

Measured on production at 05:20Z, acting as club admin
`7a13e69e-b2de-425b-b522-7edf204eaa4d` — an `admin` of SHARK CLUB
`a41434bb-8d0c-400a-8f0d-e8b3d65afed4`, whose profile role is `user` and whom
`fn_is_any_union_overseer` returns false for — **11 invoices were readable, 5 of
them addressed to player `3bb71bfe-f723-427c-aac7-a853ba04a014`**, with that
player's identity and the exact amount, and with zero delivery rows of his own:

    252efa5c  crash_prize  1.00      48ccf528  mines_prize  0.20
    641bad94  mines_prize  0.10      86d1bb02  wheel_prize  1.00
    a76eba67  crash_prize  6.34

Platform-wide, **20 of the 103 individual-addressed invoices fell outside the
gate**, all carrying amounts, across 2 individuals; 83 were correctly gated and
12 are club-level aggregates.

### The fix

Who sent a document, whether it carries a `source_ledger_id` and what category
it names are not what makes it private. Being addressed to a person is. The
final arm now reads:

    AND (i.to_entity_type NOT IN('agent','player')
      OR EXISTS(SELECT 1 FROM accounting_invoice_deliveries d
        WHERE d.invoice_id=i.id AND d.recipient_id=p_user_id
          AND d.delivery_mode='immediate'))

Everything else in the function — the `credit_limit_change`,
`accounting_correction`, `cashier_cashout` and unverified-correction arms, and
the actor self-binding — is preserved byte for byte.

Checked before applying, not after: all 20 of those invoices already carry an
`immediate` delivery row for their own payee, and the union overseer who reads
them legitimately carries one on all 20 as well. No club-level aggregate
(`union_weekly_squareup`, `union_to_club`, `union_weekly_credit_note`,
`union_club_pnl`, `club_weekly_accounting`) is addressed to a person, so the arm
never touches one.

## D2 — the latent one

`rakeback_distributions_club_member_select` was `fn_is_platform_admin() OR
club_id IN (SELECT fn_my_club_ids())` — plain **membership**, not even admin —
over a table carrying `player_user_id`, `player_rake_contributed`,
`rakeback_percentage` and `rakeback_amount`. It holds 0 rows, so nothing has
leaked; the first write would have published every member's rakeback summary to
every co-member.

It is now `rakeback_distributions_party_select`: the payee, the paying agent, or
a platform admin. That matches what its siblings already do —
`rakeback_periods.rakeback_read` and `rakeback_period_payouts`' *users read own
rakeback receipts* are both `user_id = auth.uid()`.

No club-level arm was added, because nothing club-facing reads this table. The
club weekly **aggregate** comes from `fn_club_weekly_accounting_summary`, a
SECURITY DEFINER reader that never touches `rakeback_distributions`, and
`ClubWeeklyAccountingReader` calls that reader. The only reference to the table
anywhere outside the database is `delete-club.js` naming it for cascade
deletion, which runs as `service_role` and so is unaffected.

## D3 — the enumeration oracle

`fn_accounting_party_users`, `fn_is_any_union_overseer`, `fn_union_oversees_club`
and `fn_is_union_overseer` are SECURITY DEFINER, `EXECUTE`-granted to
`authenticated`, and did not bind their user parameter to `auth.uid()`.
Unrelated user `34337d2d-5310-423d-8ae4-41a167fbb7c9`, with zero memberships,
read 2 owner/admin UUIDs out of `fn_accounting_party_users('club','a41434bb…')`,
1 out of `('union','fade…0001')`, and `true` out of all three overseer
predicates asked about somebody else. UUIDs only — roster enumeration, not bulk
disclosure — but unauthorized.

Revoking `EXECUTE` was considered and rejected: a policy expression is evaluated
with the privileges of the role running the query, and on this database every
function named in an `authenticated` policy is `EXECUTE`-granted to
`authenticated`, with no exceptions. Revoking would have broken 17 policies
calling `fn_is_any_union_overseer`, 17 calling `fn_union_oversees_club` and 3
calling `fn_is_union_overseer`.

So the three predicates self-bind instead, reusing the pattern
`fn_messenger_*_visible_to` already uses. Every caller was read first: all 37
policies and every internal caller pass `auth.uid()` — `v_uid`, `v_actor` and
`actor` are all `:= auth.uid()`. The one exception is
`fn_accounting_party_users`, which must decide overseer status for each
`union_admins` row it lists; it and only it uses the new
`fn_union_overseer_of_record`, the same predicate without self-binding, with
`EXECUTE` granted to `service_role` alone and reachable from a browser session
solely through these SECURITY DEFINER bodies.

`fn_accounting_party_users` has no user parameter to bind, so it is gated: the
engine still sees the whole roster, a browser session sees it only if it is
itself on that roster. Every reader caller already filtered the result to
exactly that identity — `fn_club_weekly_accounting_summary`
(`WHERE u.user_id=auth.uid()`), `fn_accounting_run_observation_v1`
(`WHERE p.user_id=actor`, actor `:= auth.uid()` and asserted equal to its
expected actor), `fn_messenger_private_weekly_summary`
(`WHERE u.user_id=p_user_id`, already self-bound) and the
`union_accounting_runs_scoped_read` policy — so each of their truth values is
unchanged. The three writer callers, `fn_accounting_correction_prepare`,
`fn_deliver_accounting_invoice` and `fn_issue_scope_weekly_accounting`, are not
`EXECUTE`-granted to `authenticated`, run as `service_role`, and keep the whole
roster through the engine arm.

`fn_union_can_manage_wallets` takes a `p_user_id` and was left alone: its only
third-party path is `fn_wheel_can_operate`, and all ten of that function's
callers pass `v_user uuid := auth.uid()`, while a `service_role` caller returns
true before that branch is reached.

## What this does not claim

The five named invoices are prize receipts, not rakeback: the rakeback
`club→agent/player` documents were already gated, which is why only 5 of the 11
the club admin could read were another person's. Nothing here changes an
invoice, a delivery, a notification or a chip. The weekly settler is untouched:
discovery cursor stays `2026-09-21T07:00:00Z` for both union and
standalone-club scope.

## Regression protection

`tests/fixtures/messenger-private-accounting/payee-document-privacy-preimage.sql`
commits the three defects as the installed predecessor answers them — including
a faithful reconstruction of `rakeback_distributions`, which the 2026-09-14
catalog capture does not carry — the candidate is then applied, and
`payee-document-privacy-regression.sql` asks the same questions again. It runs
inside the existing `acceptance` phase of
`scripts/dev/test-full-weekly-accounting-activation.sh`, which the required
`Accounting transactions (PostgreSQL 17)` job executes, and its log is retained
with the other phase evidence. Both files and the runner are bound into
`tests/fixtures/full-weekly-accounting/source-binding.json`.
