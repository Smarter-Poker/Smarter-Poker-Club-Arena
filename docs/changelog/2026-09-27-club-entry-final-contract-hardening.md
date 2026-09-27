# Club Entry Final Contract Hardening

Date: 2026-09-27

## Scope

This follow-up closes three defects found by the final Phase 2 source audit without changing any existing club, member, table, wallet, chip balance, or setting.

## Repairs

- Restores the final migration-order `fn_search_players` contract: global authenticated discovery, escaped substring search, indexed trigram matching, match scores, privacy-aware club and union affiliations, current-table access, and the root fuzzy flag now survive every later migration replacement.
- Aligns the client with the privacy-safe `has_hidden` affiliation flag. The locator tells the viewer that private clubs were withheld without revealing how many.
- Enforces display-name, presence, and table privacy independently; removes public club-role hierarchy from affiliations; and keeps wallet, fee, statistics, and downline details behind club-specific roster authorization.
- Rejects deleted, closed, stale, or mismatched tournament tables both in search results and at click-time watch revalidation. Page ordering is now deterministic and deep pagination is bounded.
- Keeps server-backed checklist skips unresolved on screen until the server accepts them. A rejected final skip cannot temporarily hide the opening checklist, and a refused completion latch can be requested again after a later real state transition.
- Applies the Club Arena Title Case rule at the print sites for player, club, union, role, access, table, variant, stakes, relationship, and club-description data.

## Verification Contract

- Final migration-order regression protection reads every migration in lexical apply order and inspects the effective `fn_search_players` definition.
- A private PostgreSQL 17 harness applies the exact migration as a non-superuser `BYPASSRLS` owner and executes global discovery, ACL, privacy, affiliation, fuzzy, wildcard, stale-table, and watch-access behavior.
- Component tests cover delayed and rejected final skips, completion-latch re-arming, lower-case server payloads, sensitive-account labels, and Join Club preview content.
- The standard Club Arena copy gates, TypeScript, focused UI tests, and database migration qualification remain required before protected delivery.
