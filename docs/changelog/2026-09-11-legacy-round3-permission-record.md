# Preserve the adopted Round 3 server-only permissions

The normal publication gate requires an explicit branch permission record for the replaced Round 3 function. Its actual deployed permissions already permit only postgres and service_role.

The guarded companion migration restates that same authority without changing the function body or financial data. It requires the exact adopted function and ACL before and after the operation. The existing checker and allowlist remain unchanged; the original a55 repair and reviewed UI/backend inputs remain exact.

The four-case actual-source checker proof and unchanged 41-case authorization suite pass. The root release owner verified all six functions and two triggers after application at 08:21:31 UTC, then verified both exact migration ledger entries at 08:23:41 UTC. The tool-generated companion version was reconciled through a guarded metadata-only update; SQL was not reapplied.

Evidence: docs/audits/2026-09-11-rakeback-maturity-ui/round3-acl-restatement/adoption.json. Backend adoption precedes the still-pending UI publication through normal commit, push, CI, and release gates. This does not activate broader captured accounting.
