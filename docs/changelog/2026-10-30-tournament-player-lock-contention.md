# Tournament purchase contention releases the event lane

A retained production log chain at 00:06 UTC ties a 17.918-second existing horse reward claim to a settlement profile-FK wait, then an exclusive tournament rebuy wait on the same player's mission lock, and seven retained-hand timeouts. Dinner Break PLO was playing again at 00:27:59; this change prevents the demonstrated blocking path rather than resetting an event.

The claim wrapper takes `FOR NO KEY UPDATE SKIP LOCKED`, preserving its existing serialization, reward selection and credit authority while allowing foreign-key reads. Non-addon purchase admission retains the full event/atomic/global/admission/table-cap/mission/profile order and original operator/freeze refusal precedence. Player contention raises `55P03` before funding, rolling back the uncommitted purchase receipt. Existing clients retain the exact request token; no deadline is extended.

The migration pins both installed authorities and its ordering and addon funding dependencies, verifies its single replacement and retains owner/ACL/security/settings. Existing isolated PostgreSQL funding qualification contains regression coverage and runs through the existing horse-claim PR workflow. No scheduler or new financial writer is introduced.

Source-only until protected delivery and installation are verified. PostgreSQL 17 qualification passed 28 financial/concurrency/refusal groups, including the actual Diamond addon custody/profile and non-addon KEY SHARE upgrade chains. Old-wrapper FK blocking and both old Diamond convoy counterexamples were reproduced in the preceding run; its missing fixture chip-grant owner was then replaced with the exact maintained authority before the financial qualification passed. Reward-wrapper coverage uses the existing reduced reward body, not a full reward-policy fixture.

Both changed functions declare exact derived postimage plus owner/ACL/security/config live proofs. Dependency drift refuses transactionally; no production installation, original-hand recovery, or universal freeze prevention is claimed. No TypeScript source changed; required compiler/source-contract/hook results remain delivery evidence.
