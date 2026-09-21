# tests/a-read-receipt-is-not-public.law.test.ts

A PERMISSIVE SELECT policy with `qual = true` granted to `public`, sitting next
to an `anon` SELECT grant, is not row-level security: `public` in Postgres
includes `anon`, so the table is published to anybody holding the publishable
key that ships inside the browser bundle.
`.agent/audits/2026-08-26-anon-readable-tables.md` found roughly 180 tables in
that state and shipped a triage list rather than a migration, because most of
them are a public poker-information site and revoking broadly would break the
product. Read from production on 2026-09-20 inside `BEGIN READ ONLY`, three of
its named items still had that exact shape and no RESTRICTIVE policy at all:
`social_message_reads` ("Users can view all read receipts", 97 rows),
`club_arena_messages` (`allow_read_messages`, 0 rows) and `page_notifications`
(`page_notifications_select`, 0 rows), each with `anon=rxt` in `relacl`. The 97
were Messenger read-receipt metadata - which `user_id` read which `message_id`,
and when - readable with no session, beside conversation content that
20260914163500 had already closed on `social_messages`, `notifications` and
`accounting_invoice_deliveries`; the receipts were left behind, and the two
empty tables would have leaked every row the moment anything wrote to them.
Migration 20260920173943 replaces all three `USING (true)` policies with scoped
`authenticated` predicates that mirror the surface already deciding visibility -
the conversation-participant test for receipts, club membership plus
`public.is_admin()` for arena messages, an approved `page_claims` row for page
notifications - adds a RESTRICTIVE `anon` deny to each, and revokes the anon
grant underneath, proving before COMMIT that anon selects none of the three
while `authenticated` and `service_role` keep everything they had. The forward
guard is the regression this expects: no migration after 20260920173943 may put
a `USING (true)` policy back on any of the three, grant SELECT on them to anon
or PUBLIC, or drop a restrictive anon deny. All three of those are exactly how
these tables were opened in the first place - `page_notifications` got
`FOR ALL USING (true) WITH CHECK (true)` from a file called
`20260211_security_remediation.sql`.
