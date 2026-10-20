# New public tables declare access

Supabase removes automatic Data API grants for newly created public tables on October30. New migrations now require explicit role revokes and RLS beside each public CREATE TABLE before any narrow intended grants. The same declaration checker runs in the directly triggered Explicit table access CI and ordinary push hook. Eight directly invoked Node regressions cover implicit defaults, comments/strings, quoted identifiers, multiple tables, DO blocks and uncalled stored functions.

This is a static declaration check, not an arbitrary dynamic-SQL interpreter or a certificate for historical migrations. Dynamic provisioning needs native qualification. Existing production ACLs, data and engine behavior are unchanged. Historical caller/grant qualification is owned by the Supabase audit and continues separately.

The forward declaration checker also covers public VIEW and MATERIALIZED VIEW creation/replacement, requiring explicit role boundaries without a table-RLS requirement. Ten Node declaration cases now pass. View ownership/security options and underlying permissions still need caller-specific review; this static check does not certify them.
