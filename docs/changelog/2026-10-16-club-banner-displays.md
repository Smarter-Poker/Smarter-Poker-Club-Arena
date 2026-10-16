# Club Banner Displays

Club owners now have a dedicated Banner Displays entry in the club hamburger menu. The editor is independent of Table Management and union game-management authority. It previews and updates the club's existing lobby campaign banner, restores the default artwork, and links to the existing advertising page for the separate rotating promotional strip.

The existing owner RLS and banner column grant remain authoritative. Uploads use the permitted immutable club presentation-image namespace and the live bucket's 2 MB limit. Saves compare the previous banner, return the persisted record, detect competing changes, recover a previously completed save, and notify the club lobby. The editor rejects stale account/club loads and repeated save clicks.

Regression coverage includes navigation without game authority, direct-visit refusal, upload validation, preview readiness, errors, concurrent edits and durable readback. The existing isolated Club Create production certificate now exercises the real menu, upload, persistence after reload, lobby consumer, default restoration, 393px/1440px layout and exact fixture-image cleanup.
