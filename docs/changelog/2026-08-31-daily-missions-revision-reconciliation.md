# Daily Missions Missed-Frame Certification

## Why

The Phase 4 production certification proved that the authoritative mission rows
and per-user dashboard revision advanced, while a page whose Realtime channel
reported `SUBSCRIBED` remained stale. A joined WebSocket is not proof that every
individual `postgres_changes` frame reached the browser.

## Hardened behavior

- The revision-aware atomic dashboard receipt remains the authoritative
  rendered cursor.
- Realtime remains the immediate dashboard refresh path, backed by the private
  per-user revision probe every 15 seconds.
- The full atomic dashboard RPC runs only when that cursor is newer than the
  revision already rendered on screen.
- Hidden tabs perform no database probe; the existing visibility/focus recovery
  still reconciles stale or rolled-over data on resume.

## Certification

The production Daily Missions test now intercepts the Supabase WebSocket and
deliberately drops the matching revision change frame. It separately proves the
database completed every assigned contract, the revision advanced, the frame
was blocked, and the Claim control appeared without a navigation or reload.
