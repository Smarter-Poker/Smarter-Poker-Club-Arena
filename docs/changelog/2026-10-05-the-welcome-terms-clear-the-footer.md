# 2026-10-05 - The welcome terms clear the footer

Dan, with a screenshot: "THE FOOTER IS BLOCKING USERS FROM FINISHING AND
CLICKING THE AGREEMENT."

**Cause.** `ClubArenaWelcomeModal`'s overlay and `ClubBottomNav`'s `.bottomNav`
were both `z-index: 1000`. The Diamond/club footer mounts after `<Routes>` in
`App.tsx`, so on the tie it painted over the console's last rows - the
"I Understand And Agree To These Terms" box and ENTER POKER ARENA - and a
first-time player could not get into the arena.

**Fix (root).** The modal now portals into `<body>` and sits at 9999: above the
footer, below `CompleteProfileModal` (10000) so the profile gate still opens
over it. No layout offset or footer-hiding workaround.

**Pinned.** `tests/unit/welcomeModalClearsTheFooter.test.ts` asserts
footer < welcome < profile and that the modal renders through `createPortal`
into `document.body`.
