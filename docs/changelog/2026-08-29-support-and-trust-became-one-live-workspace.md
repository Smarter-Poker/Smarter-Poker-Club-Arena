# Support and Trust became one live workspace

**Date:** 2026-08-29

## What changed

The Help Center, Legal Center, Fair Gaming, Terms, Privacy, and Promotion Rules
now behave like one retained route family. Every legal document uses the same
black-first trust-dossier shell, vault imagery, document metadata, anchored index,
and cross-document switchboard. The Promotion Rules route is again reachable from
the hamburger, so all nested Support & Legal destinations have a consistent entry.

The Help Center now offers searchable, route-accurate guidance and a real support
request instead of presenting a feedback form as a Geeves live chat. Its platform
status is live: it shares the same Supabase readiness probe as `/health`, reports
latency or degradation, and exposes a retry instead of rendering a hard-coded
operational claim.

Support submissions now claim success only after the `user_feedback` insert
succeeds. A failure leaves the dialog and description intact, reports the error,
and supplies `support@smarter.poker` as the recovery path. The unsupported
screenshot upload control was removed because no production storage contract
exists for it.

## Content governance

Fair Gaming no longer claims an external RNG certification or third-party audit
that the repository does not prove. It describes the actual shuffle, authoritative
game-state, record, detection, reporting, review, and enforcement controls.
Promotion Rules no longer hard-code mutable bonuses or VIP/rakeback values; live
campaign and entitlement surfaces are authoritative. The unused alternate
`ClubPromotionRulesModal` and its duplicate policy copy were removed.

No route, handler, permission, API, database migration, realtime channel, or
checkout contract changed in this phase.
