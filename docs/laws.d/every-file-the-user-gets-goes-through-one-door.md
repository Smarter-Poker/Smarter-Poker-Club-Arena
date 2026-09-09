# tests/every-file-the-user-gets-goes-through-one-door.law.test.ts

Phase 5 of the store-readiness work fixed `src/utils/downloadCsv.ts` so a file
handed to the user inside the app goes to the system share sheet: a webview
does not honour the `download` attribute and silently produces nothing. The
fix was correct and it was not enough. An audit of `origin/main` on 2026-09-09
found TEN screens that had rolled their own `<a download>` and never went near
the helper - among them the club bank ledger, the promo wallet ledger, the
admin audit-log export and both hand-history exports - and two of them defined
a LOCAL function also called `downloadCsv`, so a grep for the helper's name
looked clean while the app downloaded nothing at all. A fixed helper that
nothing is required to use is not a fix, so use of it is now required: a file
either goes through the one door or branches on `isNativePlatform()` to
`nativeShareBlob` itself before falling back to the attribute. The same law
covers asset addresses, which fail the same silent way: Vite rewrites a
root-relative `/assets/...` with the build's base, so one source line is right
on the web and in the app, while a hardcoded `/hub/club-arena/` prefix draws
nothing in the app and raises no error - which is how seven of them survived
into the Daily Bonus sheet after the original sweep.
