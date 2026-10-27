# PLO6 V24 price defense: development design

Status: frozen contract candidate, protected merge and held-out execution required.
This document is not qualification, selection, a default change or market profit.

The nightly `plo6_v24_price` card compares the current default against
`v24PloDefense:false`, 6,000 paired deals / 12,000 physical hands, six seats,
100 BB, all seats balanced HorseLogic, with no rake. The October 25 result
was -5.13 bb/100 with standard error 2.78; October 26 was +2.96 with standard
error 2.81. The corresponding descriptive normal 99% intervals are about
[-12.29,+2.03] and [-4.28,+10.20]. Neither is decisive. The rows lack the
source/policy/contract binding required for a locked qualification, so they
cannot be pooled across source changes or interpreted as a sign-flip repair.
No separate V24 locked qualification was found. Phase 11 pack qualification
measures a different policy contrast and supplies no V24 decision.

The development design in Plo6V24Qualification.ts compares explicit hero
`v24PloDefense:true` against false. All other options, current-worker protected
admissions, own-read initialization and public opponents must match between
arms. Hero and horse opponents use the maintained production style draw.
The physical domain is PLO6, chips 1/2, six-max tables with 2/4/6 dealt at
100 BB plus six dealt at 40/200 BB. Fees use getFullRakeConfig and the actual
player-count cap; PLO6 has no BBJ drop. Ordinary cash only: no ante, straddle,
cap, bomb pot, multiboard, tournament or Lightning extrapolation.

The shared real HandController supplies action legality and settlement. The
existing independent reference checks every final pot and published fee.
The unit is the paired hero net difference after rake, integer cents. The
stream includes common decks and an explicitly controlled initial worker
RNG seed. Natural request keys/seeds differ when a policy flag changes;
those remain visible alongside the actual common initial stream. This does
not change the production sampling protocol. Every hand starts with isolated
read containers, identical in both arms. Worker-issued plans must pass the
normal exact controller-accepted commit/retire path inside that same private
hand read view.

Before any held-out dealing, run only the development seeds and retain all
per-profile paired dispersion, fourth moment/kurtosis, divergence, runtime,
validity, source/store/admission digests and complete/incomplete attempts.
A 576-pair rotation block is the initial finite development pilot per profile.
Any further design sample must be declared before observing it and retained.
Use that flag-specific dispersion to freeze the finite matrix: the maintained
precedent is 99% planned halfwidth at most 8.5 bb/100 using 1.2 times pilot SD,
at least 10,000 pairs per profile in each gating cell, complete 576 rotations,
three preregistered held-out seed blocks, equal-profile primary weighting,
positive primary 99% lower bound, positive point estimate in every seed block,
profile/relative-position/depth 99% lower bounds at least -10 bb/100, and
trusted finite intervals. This remains a proposal pending pilot evidence and
protected contract merge; no stopping on a favorable intermediate result.

The October 9 amendment to horse-brain-winning-contract-2026-10-08.md makes
an own locked paired current-brain contract sufficient for condition (a).
Human calibration is a later withdrawal check, not a prerequisite for this
horse-population experiment. This experiment still cannot claim calibrated
human profit or universal fleet strength. No held-out seeds may be dealt
until the actual fixed contract and runner are protected-merged. Selection,
installation, natural acceptance and exact live coverage remain separate.

## Retained development and reviewed finite sizing

All five prescribed PLO6 profiles completed 576 unique development pairs with
zero recorded protocol, brain, illegal-action, conservation, card, independent
settlement, fee, truncation and paired-replay errors. The measured SDs in profile
order are 2.5384, 1.1449, 2.4822, 3.1698 and 6.0142 BB per pair. Fourth moments
and the large observed kurtosis remain diagnostics. No pilot EV mean or sign
was used to select inputs, sample sizes or the contrast.

The retained [sign-blind sizing receipt](evidence/feature-ablation/development-sizing-2026-10-27.json)
binds raw and manifest digests, exact ranges, named positions and all original
14 critical cells. Its proposed PLO6 V24 allocation is 1,230,336 pairs across
42 provider cells, about 37.02 estimated serial runner-hours at observed Mac
elapsed speed. This is a scheduling forecast, not measured CPU usage or hosted speed. It meets
the original planned halfwidth and minimum conditional sample sizes and a
conservative absolute-third-moment forecast of the original Edgeworth limit.
These forecasts do not substitute for actual held-out trust or effect gates.

Final sizing uses fresh pilots on protected b935999c78011ebfc3acbfe67f299fe80863a39f.
Earlier proposed 43d attempts remain retained and are excluded from final sizing.
The locked JSON plans bind actual default admissions, the maintained policy
source closure and frozen store/history inputs; protected merge remains required
before held-outs. The named local simulation has empty pooled
public profiles and an available empty own-history packet; it does not qualify
an active fleet's mutable public-profile cache. Fixed-work FAST semantics,
normal original receipt checks, main authority stamping, Phase 14 acceptance,
controller acceptance and issued-plan commit/retire are exercised. Live caller
second-look scheduling and production turn latency are outside this contrast.

## Independent held-out profile streams

The fixed plans declare `dealSampler: sha256-profile-seed-index-v1`. For each
profile, base seed and absolute pair index, the shuffle seed is the first four
bytes, unsigned big-endian, of SHA256 over UTF-8
`horse-feature-ablation-deal-v1`, one NUL byte and compact JSON
`[profileId, seed, pairIndex]`; zero maps to one. Only the two arms of that pair
share the draw. The 576 hero-seat/button rotation is unchanged. The independent
raw verifier checks the same coordinates using separately implemented hashing.
Legacy leagues are unchanged. The development samples supply marginal profile
dispersion only; their old shared decks are not treated as independent pooled
strength evidence. Prospective profile separation is necessary for the original
stratified variance, which includes no cross-profile covariance.
