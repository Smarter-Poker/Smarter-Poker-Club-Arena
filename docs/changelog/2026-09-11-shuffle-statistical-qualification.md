# Real CSPRNG shuffle qualification

September 11, 2026. Contributor: Codex PIPELINE STABILITY,
task `01a09108-1dfb-7e70-9e85-498926b91043`.

The current engine tests exhaust deterministic Fisher-Yates paths and rejection
boundaries, but no longer sample the actual entropy used by the production Deck.
Revision 6 D12 requires retaining those useful proofs and restoring a justified
statistical check. Production randomness and game code are unchanged.

`server/src/engine/CryptoRandom.test.ts` now deals 26,000 real shuffled decks and
counts the ace of spades in each of 52 positions. It performs one prespecified
Pearson goodness-of-fit test: expected count 500 per position, 51 degrees of
freedom, and critical value `114.07566776592196`. This is
`scipy.stats.chi2.isf(1e-6, 51)` (computed with SciPy 1.17.0). Its nominal
per-execution false rejection probability is approximately one in a million,
not zero; the chi-square model is asymptotic. Across M executions the union
bound is approximately M times that probability. There is no retry-until-pass
rule, deterministic entropy seed, or automatic production response.

The test also makes Math.random throw, preserving the requirement that the
real Deck use cryptographic entropy. The existing exact vectors remain in the
same suite and restore their mocks between tests.

For the fixed sample size and critical value, the noncentral chi-square power
approximation uses lambda = N * sum((p_i - 1/52)^2 / (1/52)):

| Defect model | Noncentrality | Approximate detection probability |
| --- | ---: | ---: |
| Ace forced into one fixed slot in 1% of deals; otherwise uniform | 132.6 | 99.8996% |
| One slot 50% more likely, removed probability spread over the other 51 | 127.4509804 | 99.8045% |
| One unreachable slot | 509.8039216 | Effectively 100%; score is at least N/51 = 509.8039 |

These probabilities describe the stated models, not all shuffle defects. A
single-card marginal cannot establish permutation independence, unpredictability,
or absence of tiny modulo bias. Exact rejection/vector tests cover those known
implementation errors; this sample checks the real entropy-to-Deck path.

Method: [NIST chi-square goodness-of-fit test](https://www.itl.nist.gov/div898/handbook/eda/section3/eda35f.htm).
Numerical reproduction: `chi2.isf(1e-6, 51)` and
`ncx2.sf(114.07566776592196, 51, lambda)` from
[SciPy distributions](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.ncx2.html).

Release status: local preparation. This record does not establish a merge,
publication, installed engine change, or final 24-hour qualification.
