# Keep Player Record mounted during scope revalidation

The private-data boundary previously restarted the member record when account synchronization announced access revalidation, including channel reconnection after returning to the page. That ancestor remount discarded drafts and reloaded the downline and every child card despite the record's own ambient-refresh guards.

Only the exact member detail route now keeps its mounted generation on this signal. Private caches are still cleared. The record receives the viewer-scoped invalidation through its existing capability-only lane, which can immediately withdraw notes, financial, role, or complete record access without replacing the workspace. A different viewer or club still gets a new boundary identity. The roster, nested statistics, and other private reporting pages retain their prior invalidation behavior.

Regression tests connect the real bus, boundary, cache clearing, and mounted record: the baseline resets the draft; the repair preserves its DOM and section read counts. Recipient filtering, complete access denial, note/role withdrawal, and viewer/club identity changes remain covered.

Access invalidation also fences an unfinished initial read synchronously. An older allowed answer cannot mount while the newer authority check is pending, regardless of response order. Denial leaves the record inaccessible; a positive verdict admits one fresh initial read. A failed initial authority check exposes the existing explicit retry instead of leaving a suspended loading screen.
