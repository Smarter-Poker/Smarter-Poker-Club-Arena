# Lightning Phase 13: Operator Controls On The Lightning Operations Page

Spec Phase 22 (Operator Controls, Emergency Drain, Cluster Freeze, Rollback),
the client operator side. The Phase 12 page could inspect a Cluster; this one
can act on it.

## What An Operator Can Do Now

In the Cluster detail (`/hub/club-arena/clubs/:club/lightning?cluster=<id>`),
a new **Operator Controls** section beneath Conversion State:

| Control                                                    | Door action                                                                                               | Confirm                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Pause Cluster / Resume Cluster                             | `pause` / `resume`                                                                                        | reason                         |
| Disable Joins / Enable Joins                               | `disable_joins` / `enable_joins`                                                                          | reason                         |
| Drain Lightning                                            | `drain`                                                                                                   | reason + type the Cluster name |
| Freeze Cluster                                             | `freeze`                                                                                                  | reason + type the Cluster name |
| Unfreeze Cluster (platform administrators)                 | `unfreeze`                                                                                                | reason                         |
| Enable Lightning / Disable Lightning                       | `enable_lightning` / `disable_lightning`                                                                  | reason (+ name to disable)     |
| Set Version / Disable Version / Enable Version / Roll Back | `set_matcher_version` / `disable_matcher_version` / `enable_matcher_version` / `rollback_matcher_version` | reason, version picked         |
| Feature Flags, Turn On / Turn Off per flag                 | `set_flag {flag, value}`                                                                                  | reason                         |

Beside them:

- **Drain Progress** (shown while a drain runs, from the row's `drain`): the
  phase (Finishing Hands, Returning To Must Move, Complete), who asked and
  when, the reason, the mode it drained from, the deadline counting down
  (gold, red at 10 seconds or less, Passed once `overdue`), and instances,
  hands and sessions remaining. While a drain or a conversion is in flight
  the detail reads every 5 seconds instead of 30.
- **Rollout Readiness**: `fn_lightning_rollout_readiness`, read once when the
  Cluster opens and again on Check Again: the verdict (Go, No Go,
  Insufficient Evidence), every reason in plain words (`READINESS_REASON_WORDS`,
  marked Blocking or Evidence, with a count or a list when the door attaches
  one), and the evidence as Pass / Fail rows (migrations applied, the four
  structural invariants, live eligible against ON, worker, open alerts, high
  integrity signals, A/A calibration, the candidate, latency ceilings).
- **Mode Transitions** now also replay the operator actions and the drain
  steps (`kind: 'operator'` and `kind: 'drain'` rows), in gold.
- Matcher Version shows the live version, the roll back target, the
  candidate, whether the candidate is being recorded, and the disabled
  versions. Set Version sets either the live matcher or the candidate
  (`role: 'live' | 'shadow'`).
- Feature Flags lists the ten Spec flags with their effective values. Five
  can be switched per Cluster (Lightning Fold, Fold & Watch, Multi Table,
  Shadow Matcher, Auto Rebuy); Lightning is the Enable / Disable control
  itself; Pool Health, Session Stats, Repeat Suppression and Adaptive
  Liquidity read Always On, because the door answers FLAG_NOT_SUPPORTED for
  them by design.
- The overview prints what an operator has done beneath each Cluster's name,
  in gold: Draining (with the step), Paused By An Operator, Lightning Joins
  Disabled.

## How A Control Is Sent

One door, `fn_lightning_operator_control(p_cluster_id, p_action, p_reason,
p_args)`, a literal `client.rpc` call so the phantom RPC gate sees it.

- The confirm dialog requires a reason of at least three characters. The
  three controls that stop a Cluster hard (Drain Lightning, Freeze Cluster,
  Disable Lightning) also require the Cluster's name typed out (case and
  spacing aside). There was no typed confirmation pattern in the repo; this is
  the first, and it lives in `confirmationPhrase` / `confirmationMatches`.
- `p_args.request_id` is a fresh v4 uuid (`crypto.randomUUID`, with a
  `getRandomValues` fallback) made when the dialog opens. A retry after a
  fault reuses it, so the door answers the repeat idempotently instead of
  acting twice; a refusal acted on nothing, so the next attempt gets a new one.
- In flight, the Confirm plate reads Sending and is disabled, a ref refuses a
  second call, and Escape and the backdrop do nothing.
- On success the dialog shows the door's before → after for mode, Lightning,
  paused, joins, drain and matcher, the changed rows lit, and the audit event
  id. A repeated request id (`replayed`) and a Cluster already in the asked-for
  state (`already`, code ALREADY) each say so in their own words. On a refusal it shows the code in plain
  words (`REFUSAL_WORDS`); `NOT_AUTHORIZED` gives the restricted note and a
  missing door gives Not Available Yet. Popup text goes through the Toast
  layer (`Cluster Paused`, the refusal sentence).
- A frozen Cluster disables every control but Unfreeze. The doors do not say
  whether the viewer is a platform administrator, so Unfreeze is shown on
  every frozen Cluster and the door judges: a club operator who asks is told
  Only A Platform Administrator Can Unfreeze A Cluster.

## #ClubArenaConsole

The section prints on the riveted detail console's glass as rows and lit
words, red ink for the three destructive controls. The confirm dialog is its
own spade console (Cancel on the steel plate, Confirm on the blue glass, red
ink when destructive, the painted pill reading Confirm, Sure?, Refused,
Restricted, Not Yet or Done), portalled to the body because the page console's `filter` would
otherwise contain a fixed backdrop. `data-popup-chassis="none"` keeps
`metallic-popups.css` off its content. The only things drawn are the
underlines of the two text fields. The global `input:focus-visible` ring drew
a rounded box around a focused field (Phase 12's fields too); the field keeps
its underline, lit brighter, instead.

Evidence: `/Volumes/SmarterArchives/agent-evidence/lightning-p13-operator-controls/`
(before and after, 393px and 1280px).

## Laws

- No card is read or sent; no parser names a card field.
- Horses are players (Law 10.5): nothing reads or labels which players are
  horses.
- Nothing navigates a player (Law 10.6); a drain returns the Cluster to Must
  Move in the database.
- The page stays lazy-loaded; the new modules are imported only by it.

## Tests

`tests/lightning/lightning-phase-13-operator-controls.test.tsx` (30 tests),
fixtures in `tests/lightning/fixtures/lightningOperatorControlDoors.ts` built
key for key from migration 20261009235505 (the row's Phase 13 keys,
`fn_lightning_operator_state`, the control answer with its `already` and
`replayed` forms, the readiness answer, the operator and drain transitions).
They pin: the reason rule, the typed confirmation, a fresh v4 request id, one
send however often Confirm is tapped, the same request id on a retry after a
fault and a new one after a refusal, before → after, every refusal in plain
words, Not Available Yet and the restricted note, frozen controls, the 5 s
drain loop, the readiness verdict and reasons, the switchable flags, the
matcher role, and the laws (literal RPC names, no rival names, no horse
marker, no card field, no em dash, no navigation, not in the entry chunk).
The Phase 12 dashboard tests pass unchanged.
