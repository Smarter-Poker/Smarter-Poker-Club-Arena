# Previous Hand Opens Saved History After Refresh

The Previous Hand icon was hidden until a hand completed in the current table
session. Refreshing or returning to a table therefore removed the direct entry
to saved hands, even for signed-in players with existing records.

Signed-in viewers can now use the existing icon immediately. It opens the same
table-scoped detail viewer and cancellation-safe history loader. The numbered
label still appears after an in-session hand completes. Guest visibility,
approved artwork, card privacy and participant-only record access are preserved.

The component regression fails before the change and verifies opening saved
history without an in-session hand, the default hidden state and the numbered
entry. Publication and actual live click evidence are retained in the task
checkpoint.
