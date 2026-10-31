# Roster controls wait for account workspace hydration

The production roster preference journey showed its search, filter and sort reset to defaults with no saved preference row. The initial account/club workspace read can replace those values while persistence remains gated, but the controls previously accepted input during that interval. The retained artifact has no network trace, so the exact live request ordering is not claimed.

Keep workspace controls disabled until an authenticated user, resolved club and matching hydrated workspace scope are present. Apply the same boundary to Advanced search/filter/sort/columns and Simple view/filter/group controls. Preserve existing search-imposed sort restrictions, directory access and unrelated actions. No timeout, test assertion, artwork, financial or engine behavior is changed.

An actual-component deferred-load regression fails before the guard and passes afterward. It verifies unavailable controls during initial loading, subsequent edits through the real workspace writer, and disabled controls plus correct values across an account switch. The focused file passes all 17 cases. Required qualification, publication and live verification remain necessary.
