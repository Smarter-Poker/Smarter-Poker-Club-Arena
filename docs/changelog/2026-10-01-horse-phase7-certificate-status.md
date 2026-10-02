# Horse Phase 7 certificate status capture

The post-deployment gameplay job completed all four cases against engine
`8068df7e66563a1a88635ce0909198438dcc884c` and removed its isolated account,
then failed while reporting the client release window (job `110166876470`).
GitHub runs the shell with `-e`; the unguarded command substitution exited on
classification code 3 before the intended status handler could run.

Both existing client and live-table reporting steps now capture the status in
an OR-list. Code 0 retains the exact-release report, code 3 retains the explicit
UNKNOWN/non-verdict for a forward publication, and all other codes retain the
hard failure. Missing release documents keep their existing UNKNOWN handling.
This does not turn a straddled client run into an exact-release certificate.

The focused regression executes the maintained workflow blocks under Bash
`-e -o pipefail`, covering unchanged, forward-publication and rejected outcomes.
Normal required source checks and protected integration still apply. No engine
runtime, production game configuration, maintenance or account lifecycle changes
are part of this reporting repair.

Horse runtime publication and observation evidence remain separate: protected
PRs 5672 and 5677 installed the observation-window change and its exact database
preimage repair. The sealed engine is 8068df7. A predeclared five-minute natural
sample contains 414 completed hands, 770 intended accepted Phase 7 decisions and
15 unchanged second-look retirements; all 785 receipts preserve their original
frame binding and contribution envelope, with no invalid or unreconciled utility
receipts. This is finite observed evidence, not GTO or population certification.
Phase 7B natural multi-board tournament evidence remains unavailable because the
inspected production domain contains no eligible bomb-enabled tournament tables.
No such tables or wagers were created to manufacture proof.
