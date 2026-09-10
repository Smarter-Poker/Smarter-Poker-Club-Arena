# Original Tournament Audit History Archive

This branch preserves the fourteen original commits ending at `d6b451b363916f7c4396dada7dd7f554cbc1879e` as an unchanged merge parent. Its other parent is published main `780398afa772b69f491586c9092016d1aca8dff6`. It is archived only at `backup/resume-poker-sep10/root-original-history`; it is not an implementation release or database approval.

Seven reviewed conflicts retain the published main versions: the phase-three progress, lifecycle and payout evidence files; the tournament registration runner; GameServer; SynchronizedBreakDeadline tests; and DetailOverviewTab. The five automatically merged engine/manager files were compared against published main. All files under `server/`, `src/` and `tests/` match that published parent byte-for-byte. Original versions remain retrievable from the first parent and the companion manifest records their hashes.

The original cancellation, obligation and elimination migrations and proofs remain historical. Their corrected, metadata-pinned native checkpoint is `24217c5024a4c031aec51dbddba531cd3c1b7842` on `backup/resume-poker-sep10/tournament-guards`. Do not apply the older copies from this archive.

The original bundled satellite helper in commits `d5beef474dc2558307d1bb9af31a9fda0421a074` and `df72341a360bbf9126a0603c1eb12dadfeb0d00b` is also historical and unapplied. It is incompatible with the current reader hash `52c3b25be3904e86f1a8558ce542ec61`. The narrow recomposition is migration `20260910160106_satellite_seats_count_once_and_keep_the_funded_prize.sql`; its final archive reference is pending the owning lane's normal commit. Database application still requires explicit approval. The separate exact-K satellite/UI archive is a different held proposal, not this helper's replacement.

Earlier runtime and heads-up work was integrated through PRs #4105 and #4163. The historical evidence here describes its original captured scope; this archive does not recertify that evidence against today's production database. New source funding and accounting proposals retain their separate activation gates.
