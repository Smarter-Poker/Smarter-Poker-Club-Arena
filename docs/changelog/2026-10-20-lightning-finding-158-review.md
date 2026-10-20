# Lightning pilot finding 158: measured operator review

Scope: the existing private six-seat Action pilot only. No activation, funding,
roster change, engine replacement or public rollout. The maintained explicit
review door records `reviewed`; it does not clear or delete the finding.

Finding 158 is TIMING_CORRELATION for players
05835920-da9b-4739-8fa2-2901b844d11d and
227ba92c-9b8c-4705-ba76-181f1f697638, detected 2026-10-20 11:07 UTC.
The original 25 windows contain 27 paired-hand timing observations. Independent
recomputation of the stored additive moments reproduces r=0.7083577754.
The next 122 windows through 14:31 UTC contain 113 paired observations with
r=0.1317385340. Combined, the 140 observations give r=0.1958767140.
This supports recording that the finding was investigated; it does not prove
innocence or justify weakening the detector. Both players remain subject to the
same rules as every other player.

The pinned review permits exactly finding 158, its exact pair, cluster, source,
pattern and measured evidence. Readback ends just after detection so the finding
is retained on the operator view's bounded page. Any changed measured field or
player refuses the write. Existing tests cover one reviewed write, no control
write, foreign ownership and changed evidence. New regression mutates every
pinned evidence field and both players.

## Reproducible timing evidence

Read `public.lightning_integrity_engine_window` for that exact cluster and pair,
with `window_to > 2026-10-19T11:07:00Z`. Split at
`window_to <= 2026-10-20T11:07:00Z`; subsequent evidence ends at
2026-10-20T14:31:00Z. Sum numbers.corr_n, corr_sx, corr_sy, corr_sxx,
corr_syy and corr_sxy. Pearson is `(n*sxy-sx*sy) /
sqrt((n*sxx-sx*sx)*(n*syy-sy*sy))`.

| Period     | n   | sx                   | sy                   | sxx                  | syy                  | sxy                  |
| ---------- | --- | -------------------- | -------------------- | -------------------- | -------------------- | -------------------- |
| Finding    | 27  | 51.5405333333333331  | 82.2046833333333344  | 124.0544634711111095 | 346.175831811388888  | 192.0648786222222222 |
| Subsequent | 113 | 269.8278499999999990 | 431.4440666666666664 | 934.6341387163888888 | 2496.551456848888883 | 1095.641320783333321 |

## Delivery and qualification boundaries

The six-seat rule from PR #7515 is already installed as migration 20261020005222.
Setup run 39358465857 switched both Classic pilots off through the seat-safe
owner door. Both six-seat targets were in Lightning mode on current readback.
Client ef1fca55944f3c108a3c839cc1cfaa695c03183f and engine
4ee7c6aa107aee1f892bc7eb3504550d897568a7 both contain the ruling.

Read-only qualification run 39439629624 observed Action 27,223 and Madness
15,931 settled recorded hands; all six sampled replays per target passed.
These samples do not qualify every recorded hand or the 54 release gates.
Action readiness is no_go for this open high signal; Madness is go.

Browser run 39439699210 accepted phone Fast Fold and observed the next hand,
then stopped at tablet fold_control_unavailable. Local session cleanup passed.
The pinned player's pool and anchor remained active on subsequent readback.
This remains partial browser evidence, not a complete player certificate.
Samantha remains on an ordinary NLH 1/2 feeder, outside Lightning.

Public launch remains NOT_CERTIFIED. Source delivery, actual reviewed status,
full replay, outsider access, financial and recovery/browser gates stay distinct.
