# Keep tournament clock reads behind newer events

An outstanding tournament or roster read could overwrite a later break event, restore a released break, or paint a different tournament after navigation. Each refresh now owns a sequence; newer reads, break announcements and effect cleanup invalidate older continuations. Cleanup also cancels the deferred zero-clock refresh belonging to the departing component.

Three rendered regressions fail before the fix and pass afterward. Positive controls retain fresh persisted countdowns and latest-request refreshes. This changes client presentation only; it does not recover an engine's retained original hands.
