# Leaderboard Rank Movement Without A False Baseline

Missing, null, and non-finite rank comparisons now remain unknown rather than
being converted into an authoritative zero. The existing leaderboard renders
Movement Unknown in its existing text treatment, preserving the approved
console artwork and valid positive, negative, and zero comparisons. Rising
continues to require a known increase of at least three positions.

The change affects only the client service and its display consumer. It does
not change ranking, settlement, wallet funding, authority, or financial RPCs.
Regression coverage includes missing and invalid values, real zero, both
directions, and rendered unknown/zero states. Local verification: 59 focused
service/recovery/cache tests, TypeScript, scoped lint, all four copy gates, and
a 393px real-component presentation fixture with loaded fonts and no horizontal
overflow. Synthetic presentation proof is not actual authorization or payout
qualification. Protected integration and published behavior remain separate
release requirements.
