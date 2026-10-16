# Live Preferences And Ticker Clearance

Game-list preferences now hydrate before paint, restore again when the account changes, and use account-and-club cache keys. Existing browser preferences are adopted once. Remote writes preserve tap order so a slower earlier selection cannot overwrite the last selection. Table Studio also remembers the account's selected Apply To game type across remounts.

A live table no longer assumes Hold'em before its metadata arrives. The saved appearance must resolve before artwork is requested or revealed, and account/game scope changes cannot reveal the previous scope's art. The loading cover and button preloader now render as JSX; both had accidentally been placed inside comments or stylesheet text. Failed preference reads retain a visible retry instead of presenting a default as the saved table.

Ticker clearance is published before paint and retained through its exit. Late header mounts and nested scrolling update the ticker's anchor without the former two-second cutoff. Existing approved artwork and engine APIs are preserved.

Eight focused regressions fail against the original source. Focused verification passes 110 tests; final compiler, full suite, build, protected integration and production evidence are recorded in the owning task checkpoint.
