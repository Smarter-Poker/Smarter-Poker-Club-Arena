# Scoped successor admission errors

After an engine process changes, a tournament may fail before its new manager
is admitted. The existing bounded log reader recognized `Tournament` and
`TournamentManagerBase` messages, but excluded the `GameServer` call sites that
own this path. A zero-match observation could therefore omit an actual
successor-admission failure.

The maintained reader now accepts exactly three additional contexts:

- `GameServer.Tournament_resume_failed_for_t`: the RUNNING discovery admission.
- `GameServer.tournament_admission_retry_failed`: its existing causal retry.
- `GameServer.mixed_original_recovery_retained`: a mixed-custody continuation
  that catches its failure and retains the admitted owner.

This is a read-only diagnostic correction, not a tournament recovery or an
engine change. It does not admit general GameServer logs or the separate BAGGED
stage-resume path. Exact selected UUID matching, symbolic-only output, record,
byte and time bounds, host identity checks, pinned transport and credential
cleanup remain unchanged. No host observation, lease operation, financial call,
restart or migration is performed by this change.

The real local pipe regression returned zero matches before the correction
and all three selected contexts afterward. It also rejects unrelated GameServer
contexts, context-name suffixes, other events and partial UUIDs, and proves
password, token, SQL argument and stack payloads do not reach the result. All
nine native reader cases pass. The existing `scopedRuntimeErrors.test.ts`
continues to run this native fixture through the ordinary client test workflow.

Source reviewed at protected main `5f613996524e75eb8afae29dd2751084e59c6ee3`;
the directly affected admission call sites were traced in serving source
`6b6eabb1b169aed14fcb9fbd0ae54ee2bc42b2d4`. Missing records still mean unknown,
because silent admission returns and bounded observation remain distinct from
an observed exception. Publication of this reader requires no engine activation.
