# Accounting qualification finishes within its existing job budget

PR #8333 run40542328149 accounting shard1 was still progressing when its
40-minute job limit cancelled Spin expiry; the final required gate correctly
refused the cancelled matrix. The same fixture inputs passed in #8326 in
27 minutes, but the slower attempt spent893 seconds in weekly recompute,
380 in scoped launch and295 in the interrupted final suite. Shard2 finished
in1203 seconds.

Move only the complete unchanged weekly-recompute proof and its always-upload
to existing shard2. The observed slow-work projection is2096 seconds there,
leaving304 seconds before the existing2400-second cap. This also removes893
seconds from shard1. Every native command, assertion, deadline, artifact rule,
four-way matrix and required aggregate remains enforced. A routing regression
fails before the move and pins the proof and evidence to shard2 afterward.
Hosted qualification is still required; arithmetic is not execution proof.
