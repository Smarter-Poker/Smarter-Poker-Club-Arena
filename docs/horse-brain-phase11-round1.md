# Horse Brain Phase 11: PLO5, PLO6 and PLO8

This first round provides separate, explicitly heuristic packs for five-card high, six-card high and four-card eight-or-better Omaha. Production evaluates them in shadow mode. Candidate selection and a fixed evidence clock remain forbidden at the live worker boundary. Implementation and verification are separate from protected publication, natural execution and strength promotion.

The user authorized Phase 11 implementation while the preceding Phases 8–10 engine release is pending. Their release certificate remains open; this overlap changes sequencing only.

## Domain and ownership

| Variant   | Hole cards | Cash seats | Tournament seats | Pack                 |
| --------- | ---------- | ---------- | ---------------- | -------------------- |
| PLO5 High | 5          | 2–7        | 2–9              | plo5-high-round1-v1  |
| PLO6 High | 6          | 2–6        | 2–7              | plo6-high-round1-v1  |
| PLO8      | 4          | 2–8        | 2–10             | plo8-split-round1-v1 |

Seat ceilings come from the actual cash configuration and tournament deck owner. Supported geometry is a single board, pot limit, positive effective depth through 250 BB, ante through 1 BB, the existing 2 BB straddle flag, and configured rake through 10 percent with a finite cap. Fixed limit and multiple boards have explicit boundary receipts. Phase 12/13 own those separate policy programmes.

`HorseLogic.decide` calls `evaluateOmahaVariantPolicy` after the baseline is legalized. `OmahaVariantPolicyPack` owns independent hand-shape scores and entry bars. Only public seat/role geometry and the legal preflop action kernel are shared with Phase 10. No PLO4 strength table or percentile is imported. Postflop uses Phase 9 exact-card facts, a separate variant sampler and canonical per-pot eligibility. Phase 7 evaluates tournament utility. `workerRuntime` rejects offline activation controls; `ServerTableEngineTurns` records accepted, coerced, fallback and unexecuted outcomes, including retirement of stale or superseded decisions.

Shadow sampling owns a local random stream derived from the existing decision state. It does not advance, reseed or restore the baseline stream. One physical deck excludes public cards and hero cards; every dealt opponent, including folded seats, consumes unknown cards. Opponent private cards are never read. Public actions condition a bounded sequential heuristic prior, with at most three attempts per seat and an explicit final uniform escape. This is not a calibrated solver posterior or the independent oracle's joint rejection distribution. Load governs the requested sample count; the policy checks its elapsed work budget and retains the baseline on exhaustion.

## Split-pot behavior

High, low and combined shares are calculated separately for each pot's eligible players. No qualifying low awards the whole pot to high. Tied lows can produce a quarter or sixth; different side-pot eligibility can let the hero scoop a side pot while losing both main-pot halves. The policy records nut and backup lows, counterfeit exposure, high-only and low-only structure, observed scoop/freeroll potential, and quarter/sixth risk. Tied nut high and tied nut low do not override a measured quartering guard.

Live samples provide continuous pot-share estimates; the independent oracle also applies actual chip rounding and refunds. Confidence bounds describe sampling uncertainty conditional on the supplied heuristic ranges. They do not certify those ranges, future betting EV or poker strength. Malformed probability distributions, mismatched eligible pots and nonfinite values cannot authorize a candidate action.

Low facts use rank masks with the same exact-two-hole/exact-three-board rule and the original low score encoding. The optimization was compared against the previous complete fact implementation, including every one-card transition, across 1,200 fixed-seed deals. The retained comparison and original failed timing run belong in the external evidence bundle.

## Evidence and completion gates

September 14 audit correction: the independent program and its public-range producer now use the canonical dealt-seat census. Their previous sit-out filter could remove an away all-in winner or folded physical deal while the live policy still counted it. Regression evidence retains the 150-chip main pot won by the away all-in and the 300-chip side pot won by hero, and preserves folded dealt-card occupancy in all three variant priors. These repairs require new source-bound reference and release qualification; historical results do not certify the changed source.

`horse:omaha-variants-evaluate` calls the independent reference adapter and the shared physical controller runner through the Phase 11 registry. Its 18 fixed populations cover all three variants, actual cash and tournament maxima, short/deep stacks, rake, ante, straddle and contrasting opponent styles. Three seeds are frozen before results; each replay uses at least ten pairs per population to cover every relative position. The benchmark records the real sampler work, legality, physical cards, rake and conservation. Tournament benchmark net chips are not prize EV. Negative outcomes remain evidence and no strength promotion is authorized.

The dimension suite evaluates 925,320 PLO5, 539,880 PLO6 and 1,310,760 PLO8 preflop coordinates through the actual action kernel. Postflop geometry tests cover 4,260, 2,820 and 5,340 rows respectively: all supported seat counts and dealer-relative positions, every street/role and short-to-deep stacks, with pairwise rake/ante/straddle overlays. These postflop overlays are not a claim of a full Cartesian strategy or calibrated solver matrix.

Required closeout: final source review, typecheck/build, focused and full integrated checks, two source-matched concurrent benchmark replays, measured policy latency and completion share, protected merge, canonical engine/page publication and natural per-variant execution. The isolated timing probe does not prove live queue, utility or fleet latency. Production counters include per-variant eligible/fired, reasons, execution outcomes and latency histograms. A successful page release, healthy older engine or compiled shadow pack does not close these gates.

Status at introduction: implementation under verification; publication and natural-use evidence pending; every pack remains shadow and unpromoted.
