# Winning hero cards follow the display sort

The hero sorts private hole cards for display and preserves that order at showdown. The server still numbers winning hole cards in its dealt order. Passing those raw indexes to the sorted hero row could identify J/6 instead of K/J for dealt 6-A-K-J-5, which would raise the wrong cards after the winning-card lift.

Map server winning indexes to the actual displayed cards by rank and suit. Preserve explicit empty arrays, keep RIT award indexes in their existing display order, and retain dealt order on both public snapshot recovery paths as well as the existing private realtime/recovery paths. Clear the old order at the next hand. Opponent mapping remains unchanged.

The actual sorted SeatSlot regression failed with J/6 before the correction. Retained tests cover sorted and unsorted rows, suit/ten normalization, RIT union, empty/missing/invalid metadata and hidden cards, and pin the live page wiring. This follows PR #8495 on its own branch; both changes are client-only and require no engine activation. The separate exact-equity update remains at the owner's October 29 04:00 Chicago choice.
