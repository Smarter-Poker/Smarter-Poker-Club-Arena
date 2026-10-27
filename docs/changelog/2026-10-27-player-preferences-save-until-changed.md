# Player preferences save until the player changes them

The lobby previously cleared and saved Advanced Filters automatically when a
changing board produced zero matching games. That automatic reset is removed;
Show All Games remains the explicit reset. A filter-sheet selection is now
stored and marked pending synchronously, before its remote debounce, and an
older write cannot clear the pending marker for a newer selection.

Settings-page controls apply and cache on selection and sync automatically.
Slider/search bursts send their final value, with pending writes flushed on
close/page exit. Returning to the tab cannot replace a pending choice. Table
settings serialize per-column writes across hook instances and keep
account-scoped pending choices through reload; stale database echoes and
in-flight reads cannot overwrite newer local edits. The touched marker must
succeed before an intent is retired.

Appearance network failures retain the chosen art and original mutation ID;
the next explicit theme/account opening resumes that same idempotent request.
Definitive ownership/validation refusals retain their existing rollback.
Interface mode also keeps a pending account-scoped selection rather than
rolling back on a lost connection. Player, statistics, shop and operator
filter/sort controls use durable per-account/per-club preferences without TTLs.
Roster workspace and existing lobby view owners remain authoritative.

Migration 20261027173138 creates user_page_preferences, with independent rows,
size/key constraints, owner-only RLS and account-deletion cascade. No money or
gameplay data is rewritten; there is no new engine dependency or repair loop.
Its isolated PostgreSQL test exercises upsert, independent controls, account
isolation, invalid input, anonymous refusal and deletion cleanup, and runs from
the existing Data Console PostgreSQL workflow. Browser certification checks
Settings autosave and account-row readback after a notification-filter reload.

Tests explicitly reset persistent browser preferences between independent
fixtures. Financial-journal assertions now locate their own journal rather
than assuming it is the only localStorage entry. A pre-existing submission blocker was repaired: a reviewed workflow binding
omitted protected treasury qualification additions; its audit records the
reviewed source and digest. No production financial behavior or required
assertion is weakened.

Delivery and exact evidence are recorded in CHECKPOINT-player-preferences.md.
