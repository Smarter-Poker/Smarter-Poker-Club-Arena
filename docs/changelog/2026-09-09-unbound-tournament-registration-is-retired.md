# Initial Tournament Registration Cannot Bypass Request Receipts

The one-argument `fn_register_for_tournament(uuid)` alias admitted a wallet purchase without an immutable operation ID. The published receipt-bound client no longer calls it, but leaving its authenticated grant open allowed older clients to continue using the unsafe path.

Migration `20260909220951_retire_unbound_initial_tournament_registration.sql` revokes PUBLIC, anon, authenticated and service_role execution of that alias. The receipt wrapper remains authenticated-only. The two-argument internal core retains service-only access and remains callable by the SECURITY DEFINER receipt and seat-first wrappers. No money or historical record is rewritten.

The migration pins the reviewed receipt-wrapper definition and checks its ACL plus the internal core's ACL before changing the old alias. It was applied through Supabase as version `20260909221729`. Read-only verification confirmed the exact resulting privileges. Do not reapply it.

Before retirement, both public and origin frontend served `24a22ade8ac865b6f3ae4d3e0bc047e4bddff88d`, built at 21:58:49 UTC on 2026-09-09 by publisher 34409606874. Ancestry and source blobs prove registration PR 4028 and seat-refund PR 4020 are included. The batch is frontend-only; an engine restart is not required for this alias retirement.

Active TypeScript/JavaScript source inspection found only historical comments referring to the old alias. Live routine inspection found the receipt wrapper and internal seat-first helper using the two-argument core. The alias itself only forwarded to that core.

The isolated PostgreSQL journal harness completed, including 15 registration assertions. The actual retirement SQL is embedded twice inside a rollback fixture, preserving every guard and DDL statement while removing only its outer transaction delimiters. Tests execute the old route as anon, authenticated and service_role and require denial. Authenticated registration through the real receipt wrapper succeeds and replays with only one additional core call. The funding core remains a test double; this is receipt/authorization evidence, not full entry-economy acceptance.

This closes the legacy initial-registration alias gap. All 12 CA-03 controls remain open for their full behavioral and release requirements. The separate staged tournament cutover remains unapplied pending its actual hand-settlement prerequisite and complete rehearsal.
