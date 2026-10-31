# Natural Three-Run History Recency

Owner: chat01a190a6, sole RIT selector writer avatar_finish. Scope: repair the existing passive natural-three-run observer selection; no gameplay/client/engine/database change. Branch fix/rit-history-recency-01a190a6, base54976b3f59c8f673e27cbe06259c6e250a8e33dc.

Actual16:14Z bounded history read showed PLO5 table42f63a69 had two three-run hands, latest14:28:49Z, while Short Deck09ee and FLH19e each had one at15:51Z. The old selector ignored timestamps and chose the older table again after a20minute observer there produced no multirun event. Missing actual3coverage remains unverified; the prior client drift is not waived.

## Change

File tests/e2e/support/naturalMultiRunMobile.ts, original lines82–85/116–165/187: history projection discarded created_at; target3 sorted count first. Retain created_at in the same bounded indexed read and rank target3 by latest valid actual three-run timestamp before the unchanged tie breaks. A later two-run hand does not advance this timestamp. Missing/invalid timestamps retain the prior count-based tie break. Other requested formats, eligibility,32candidate/500row/twohour/fourparallel limits, setup and20minute budgets are unchanged.

File tests/unit/naturalMultiRunMobile.test.ts: one regression reproduces the actual stale-two-versus-recent-one boundary and checks later two-run activity plus missing/invalid dates. Existing projection assertion now requires timestamp retention. The actual old helper produced one failure/74passes, expected short-deck but received stale; red.log retained externally. No timing/coverage/identity assertion was changed.

Before/after source reread and diff reviewed. The corrected existing unit file passed all75tests (green.log); app TypeScript passed with no diagnostics; protected checks/merge remain pending. Existing maintained passive proof must still capture actual3runs,4000–4700ms result gaps/finalhold, allwinnerlandings, strictbothorigin/client/engine/instance provenance and guarded fixturecleanup. Latest explicit human constraint forbids using active player games. The earlier conditional production observer plan is withdrawn; no observer/account/browser has been started for this correction. Further actual3 timing proof requires the supported isolated real-component qualification venue; source-only selector delivery does not close that acceptance.

## References And Evidence

Full canonical policy reader16:14:35.981Z, policy2.9/manifesta659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b and four hashes unchanged from current audit receipts; truncated hardening reread fully. Current repository AGENTS/playbook/PUBLISHING read; fullCLAUDE/deploypaths read on this same54976 source during continuous audit, no instruction drift. MAC-STORAGE read and ownmountedSSDdisk5s1 free757GiB/archive49GiB verified. No nested test instructions. Root reviewed this exact minimal design before changes. Locked rootdependencies byte-compatible and APFScloned from consented read-only sibling into owned realdirectory; no shareddependency mutation/install. All temp/npm/test data privateSSD. Evidence /Volumes/SmarterArchives/agent-evidence/chat-audit-01a190a6/rit-selector-recency; root retains shared acceptance ledger.
