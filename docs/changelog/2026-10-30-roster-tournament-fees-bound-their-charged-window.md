# Bound the roster tournament-fee boundary read

The original 100-member Kings Club weekly summary timed out. Its tournament
fee edge alone also exceeded an eight-second read-only diagnostic budget. The
actual plan used the club/member index to fetch lifetime rows from a 3 GB source
before testing the charged time.

Add one concurrent B-tree cover on club, member and charged time, including the
existing fee value. The fee reader, amounts, source rows, immutable receipt
rules, private read permissions and original inventory source generation stay
unchanged. Installation verifies the current reader, original table authority,
all existing indexes and exact valid new index through the existing applier.

Private PostgreSQL 17 qualification executes the retained reader's exact edge
query over 100 members with long histories and interval boundary cases. It
checks identical totals and source rows, a natural index-only time-bounded scan,
unchanged permissions, valid-prefix resume and invalid-index/freeze refusals.
The required fourth accounting shard runs this proof and retains its report.

This repairs one demonstrated physical read bottleneck. The cash reader and
whole-response runtime still require separate qualification. Protected merge,
installation and actual production readback remain required.
