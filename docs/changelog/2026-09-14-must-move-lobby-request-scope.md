# Must-Move lobby replies stay with their game

The always-mounted lobby and table-side controls could apply a delayed reply
after switching games. An older poll could also overwrite a newer update, and a
join reply could navigate after the lobby had been closed and reopened.

Both readers now share a game/opening-scoped request lifetime. Only the newest
read can update it, old game actions disappear while the next game loads, and
retired actions cannot show notifications, reload, close, or navigate. A
synchronous action token prevents two taps submitting twice before React renders.
Temporary read failures still retain the same game's last known information;
game-not-found clears it. Poll intervals, layout, styles, and database operations
are unchanged.

Six regression cases failed against the previous implementation and pass with
the fix. Additional controls cover stale failures, unmount, duplicate taps, and
successful current navigation. This is source evidence, not Phase 2 certification.
