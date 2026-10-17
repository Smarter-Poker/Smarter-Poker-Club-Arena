# The Horse Tournament Scoreboard Measures Real Finishes

- The daily scoreboard measured every horse finish as a win: it divided by the tournament's live player count, which
  is zero once the tournament is over. Finishes are now measured against the real field (every seat, horse or human),
  so 0 is a win and 1 is first out.
- Satellite winners (who finish with no position) now count, as first. This carries the rule from PR #7091, whose
  scoreboard migration must not be installed after this one.
- Every day already on the scoreboard is recompiled under the one rule.
- Proof: local Postgres 17 fixture (5-seat MTT with a human seat, 6-seat satellite with two seat winners): finish
  percentiles 0 / 0.25 / 0.5 / 1, satellite ROI -9.1% (the fee).
