# Support and Trust route/content audit

**Date:** 2026-08-29
**Scope:** Club Arena hamburger `Support & Legal`, every linked page, each legal
document, the support-request dialog, and the shared platform-health signal.

## Route inventory and disposition

| Route or surface          | Purpose                                               | Before                                                                                                                                                | Finding                                                                                                                                                           | Disposition                                                                                                                          |
| ------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/help`                   | Player guidance and support intake                    | Generic glass cards, stale answers, a feedback form labelled as a Geeves live chat, hard-coded green system status, and a conflicting support address | The page overstated capabilities and could report success when persistence failed                                                                                 | Retained and rebuilt as the Help Center with searchable verified guidance, live health, canonical links, and an honest support queue |
| `/legal`                  | Legal and trust index                                 | Retained-page workspace from the navigation cleanup                                                                                                   | Correct owner for the document family                                                                                                                             | Retained as the canonical Legal Center                                                                                               |
| `/legal/fair-gaming`      | Integrity rules, conduct, reporting, and review       | Orange glass treatment with unsupported third-party certification and audit claims                                                                    | The implementation supports cryptographic shuffle inputs, server authority, records, and detection signals; it does not establish an external certification claim | Retained, corrected, and rebuilt as document `CA-FGP-02`                                                                             |
| `/legal/tos`              | Platform and account terms                            | Separate legacy layout and duplicated navigation                                                                                                      | Content was difficult to scan and visually inconsistent                                                                                                           | Retained and rebuilt as document `CA-TOS-02`                                                                                         |
| `/legal/privacy`          | Data collection, use, security, and controls          | Separate legacy layout and duplicated navigation                                                                                                      | Content was difficult to scan and visually inconsistent                                                                                                           | Retained and rebuilt as document `CA-PRV-01`                                                                                         |
| `/legal/promotions`       | Platform and club campaign governance                 | Hard-coded reward amounts, VIP/rakeback values, and offer mechanics                                                                                   | Static copy could conflict with live campaign, entitlement, and claim data                                                                                        | Retained, made live-term authoritative, and rebuilt as document `CA-PRM-02`                                                          |
| `/health`                 | Public uptime/readiness surface                       | Per-page Supabase readiness implementation                                                                                                            | The Help Center needed the same signal and previously faked it                                                                                                    | Retained; readiness logic moved to a shared hook used by both surfaces                                                               |
| Support-request dialog    | Authenticated issue/suggestion/account request intake | Insert errors were swallowed; success appeared regardless; screenshot UI targeted an unprovisioned storage bucket                                     | The interface could lose a report while telling the player it was queued                                                                                          | Retained, renamed accurately, made keyboard-safe, and wired to truthful Supabase completion/error states                             |
| `ClubPromotionRulesModal` | Intended club-creation acknowledgement                | Unreferenced 300-line alternate promotion policy and its own styling                                                                                  | Dead duplicate; no runtime caller or acceptance flow                                                                                                              | Removed                                                                                                                              |

## Content and contract corrections

- Fair Gaming now describes only behavior supported by the game and integrity
  implementation: cryptographic random inputs, unbiased Fisher-Yates shuffling,
  server-authoritative actions, hand records, automated signals, manual review,
  player reporting, and account/device/network controls.
- Promotion Rules no longer duplicate mutable reward amounts. `/promotions`,
  `/bonuses`, `/rakeback`, and `/vip` remain the authorities for each live offer.
- Help no longer calls a feedback form “Live Chat With Geeves.” It offers a real
  support request and the canonical `support@smarter.poker` recovery path.
- Support success is emitted only after `user_feedback` accepts the insert.
  Failures keep the dialog open, expose an alert, and preserve the player's text.
- The unsupported screenshot control was removed. No storage bucket, migration,
  API, permission, or realtime contract was invented for this phase.
- `/health` and Help now share one read-only `settlement_periods` readiness probe,
  latency measurement, degraded state, and retry path.

## Before sitemap

```text
Support & Legal
├── Help Center                      /help
├── Legal Center                     /legal
├── Fair Gaming                      /legal/fair-gaming
├── Terms Of Service                 /legal/tos
└── Privacy Policy                   /legal/privacy

Legal Center / section rail only
└── Promotion Rules                  /legal/promotions
```

The promotion document existed but was missing from the hamburger's Support &
Legal group. The Help Center and each legal page owned a different visual and
navigation pattern.

## After sitemap

```text
Support & Legal
├── Help Center                      /help
├── Legal Center                     /legal
├── Fair Gaming                      /legal/fair-gaming
├── Terms Of Service                 /legal/tos
├── Privacy Policy                   /legal/privacy
└── Promotion Rules                  /legal/promotions
```

Every retained document is reachable from the hamburger, the Support & Rules
section rail, the Legal Center, and the document switchboard. Legal routes remain
public so terms can be reviewed before signup; Help and its support queue remain
authenticated.

## Route change ledger

- **Removed routes:** none.
- **Merged routes:** none; the dead unmounted promotion modal was removed instead.
- **Renamed routes:** none.
- **Added routes:** none.
- **Redirects added:** none required.
- **Navigation addition:** `/legal/promotions` is now present in the hamburger.

## Visual and accessibility contract

The retained pages now use a shared Smarter Casino Realism trust-dossier system:
near-black editorial surfaces, a vault-lit photorealistic anchor, restrained blue
energy seams, machined gunmetal frames, crisp typography, chamfered small radii,
and no glassmorphism or arcade ornament. Desktop uses a sticky document index and
reading surface; mobile turns the index into a contained horizontal rail.

Semantic headings, landmark labels, skip-friendly anchors, visible focus rings,
44px interactive targets, dialog focus containment/restoration, Escape dismissal,
live-region status, reduced-motion behavior, and no-horizontal-overflow rules are
part of the retained contract.
