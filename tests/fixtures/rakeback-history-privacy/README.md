# Payee history privacy — SOURCE ONLY / UNRUN

The 161500 forward component follows 161000 table-authority closure. It is
outside automatic migrations. Its preimage is the actual policy/table-owner
readback at **2026-09-15 00:58:27.649778 UTC**, saved in
`outputs/accounting-40398-period-visibility-policy.json` in the accounting task.
`policy-preimage.json` carries the same bounded query/result and original file
SHA256 inside this portable fixture; it contains catalog metadata, not user rows.
The guard requires exactly the four observed policies, their roles, commands,
permissiveness and complete expressions, postgres-owned tables with RLS, and
the predecessor's removal of effective table/column writes. It also refuses
anon/authenticated superuser, BYPASSRLS or effective service_role inheritance
(`pg_has_role(...,'USAGE')`): the retained service policy must never become a
client read path through the role graph. The component does not repair or
change role memberships. An unexpected
permissive policy cannot survive as a second route. Service policies and all
data remain unchanged.

Active caller inventory: `src/pages/RakebackPage.tsx` reads periods only for the
signed-in user (both queries and its realtime filter). No runtime TS/JS caller
in `src`, `server/src` or `supabase/functions` reads or writes
`rakeback_period_payouts` directly. Club financials and Club Data use separate
summary/invoice RPCs. The canonical `fn_club_weekly_accounting_summary` checks
club-party/union-overseer authority and produces weekly totals by payee tier;
the canonical issuer stores that aggregate as the club's weekly invoice.
No club-owner or agent exception is needed for another person's raw periods
or payout receipts. Own history remains accessible without a current membership.

Protected execution input: load the real `full-weekly-accounting` catalog,
captured ACLs/registries and all candidate components through 161500, then admit
`regression.sql` in the isolated PostgreSQL 17 fixture. Do not run a direct
database, shell, cloud or CI fallback. Root owns candidate/custody/runner
integration. No auth, role, business function or RLS helper is substituted.
Only synthetic seed construction disables triggers; origin behavior is restored
before all actual `SET ROLE`, JWT-context, table SELECT and summary RPC probes.
The temporary SECURITY INVOKER helper reports assertions only, with explicit
USAGE on its actual temporary schema name (resolved from `pg_my_temp_schema()`)
and EXECUTE granted to the three tested roles.
These temporary fixture grants do not change application-schema privileges.

The source cases cover two-club own history, explicit other-user queries,
inactive/departed membership, no current membership, unrelated nonmembers,
club-owner access limited to their own rows, anonymous role even with a
subject-shaped value, missing subject/null-user history, preserved service
read access and absent direct service writes. The real aggregate reader must
still admit an owner and refuse an ordinary member. Its seeded open period
must remain unreconciled: these probes qualify read access and result shape,
not payment, source calculation, completed invoices or correct aggregate sums.
The seeded historical payout receipts are not financial acceptance evidence.

Separate fresh-database guard cases for the protected plan: reapplication;
changed policy expression/role/command/permissiveness; an extra permissive
authenticated SELECT policy; disabled table RLS; changed owner; and restored
table or column UPDATE grant; an inherited service_role edge for either client
role; or direct SUPERUSER/BYPASSRLS on either client role. Each must refuse before either read policy is
changed, with policy/ACL snapshots identical across the failed transaction.
The component's guard intentionally refuses a drifted preimage rather than
guessing which permissive policies are safe. Additional guard variants, full
fixture dependencies, SQL execution and live installation are pending;
no pass or production-privacy claim has been made.

`rejected-service-membership.sql` is a distinct negative input for a fresh
isolated cluster loaded only through 161000. It introduces an inherited
service-role membership for authenticated after direct writes are retired,
includes the actual 161500 source, and requires unchanged policies, ACLs and
the injected role graph after rejection. It then restores and compares the
original role graph. The protected runner must require the exact error
`rakeback privacy unsafe API role: authenticated` and transaction rollback;
another SQL error is not acceptance. This source deliberately disables psql
stop-on-error only around that expected-to-fail component transaction. Do not
reuse the successful acceptance fixture or preserve the injected membership.
Repeat with an anon edge and direct role attributes as separately admitted
fresh guard cases; those additional variants are plan inputs, not executed
claims. All negative execution and cleanup receipts remain pending.
