# Keep The Live Lobby Controls Below The Ticker

Live verification of PR #7043 found that standalone club filters still pinned directly below the global header, underneath the visible ticker. At 375px the ticker ended at 69px while the selector deck pinned at 38.22px, covering about 31px of controls during scrolling.

The selector deck, the sort row, and native focus scrolling now include the ticker's published height. A missing ticker still adds zero space, and the existing scroll-direction hide/show behavior reads the updated computed sticky position without changing its rules. The approved artwork and desktop layout remain unchanged.

The maintained CSS Beat lobby suite covers both standalone and in-tab layouts at 375px and 393px, including changing ticker heights and removal. These four cases failed before the source fix. This is a client CSS follow-up; it needs no engine replacement or maintenance cutover.
