# Realtime cashier lifecycle under settlement

The required TypeScript Check joins the existing native fixture job. Its checked
cashier driver builds the exact candidate's real application, opens two genuine
GoTrue sessions in Chromium, and runs requests, approval and rejection through
PostgREST and the captured authoritative v2 SQL. Both current and legacy
settlement locks remain active throughout. No production account or chip is used.

The agent queue opens before the player requests. The player dialog opens before
the agent decides. Native Supabase Realtime subscription acknowledgments and row
events are observed on the browser WebSocket; neither refresh nor a mocked event
can satisfy the lifecycle. Each transition must update the other browser within
five seconds. Database readback checks exact custody, ledger legs, durable events,
duplicate replay and an unauthorized actor's refusal.

`functions.jsonl`, `tables.jsonl`, `triggers.jsonl` and `metadata.jsonl` are a
read-only catalog capture from PokerIQ-Production at the recorded timestamp.
They contain definitions, constraints, RLS, ACLs and trigger metadata, not player
rows or credentials. `registry.json` contains only ledger store/mode configuration.
The composer preserves captured function bodies/owners and effective execution
rights for the three application roles, table privileges, policies and affected
triggers. Native GoTrue owns Auth schema creation. Synthetic baseline rows are
seeded before financial execution; application triggers remain active for all
cashout commands. This is scoped qualification, not complete production parity
or a product-wide certificate. Production publication and live proof remain
separate requirements. Catalog changes require a reviewed refresh and requalification.

`build-client.mjs` produces a test-only candidate bundle with an inert public
routing key. It cannot publish. The normal production build, provenance admission,
protected merge and static publisher remain intact. The no-egress native image
maps that public routing key to its disposable anonymous key; authenticated user
JWTs still reach real GoTrue/PostgREST/Realtime.
