# #ClubButtons Operational Handoff

## Start here

This is the continuation package for the Smarter Poker Club Arena `#ClubButtons` work. Use the existing repository and architecture; do not create a replacement implementation.

- Repository: `Smarter-Poker/Smarter-Poker-Club-Arena`
- Continuation worktree: `/Users/smarter.poker/Documents/.agent-trees/Smarter-Poker-Club-Arena/codex-clubbuttons`
- Active branch: `codex/club-lobby-command-top`
- Pushed checkpoint before this handoff: `a01d21c3cd8d6f874895d220b838bdfd0dd805fa`
- Preserved earlier mixed work: branch `codex/clubbuttons-preserved-20260828`, commit `657925db0`
- Canonical design source: `design/club-buttons/`
- Canonical runtime components: `src/components/club-buttons/`
- Canonical runtime artwork: `public/assets/club-buttons/`

Read, in order:

1. `../CLUB_BUTTONS_MASTER_SPEC.md`
2. `../documentation/ASSET_MANIFEST.md`
3. `../documentation/IMPLEMENTATION_PLAN.md`
4. this file
5. `NEXT_STEPS.md`
6. `../documentation/session-prompts/GAME_CARD_IMPLEMENTATION_DIRECTIVE.md`

## Product objective

Upgrade Club Arena UI to a premium, mobile-first, black/brushed-metal casino system with restrained electric-blue crystal accents. Data, permissions, realtime subscriptions, navigation, and actions remain live application behavior layered over artwork; artwork must never contain changing values.

## Current state

Completed and locked:

- Club identity card with dynamic club/user data.
- BBJ plaque with dynamic jackpot value.
- Long single-line wallet artwork and dynamic wallet values for the role-appropriate wallet rows.
- Nine wallet families are archived: Diamonds, Club Bank, Promo Wallet, Agent Wallet, Player Wallet, Union Bank, Rake Treasury, Backup BBJ Wallet, and Spins Treasury.
- The premium lobby command top contains the welcome header, Find Your Game controls, and campaign bar.
- The top-three release is pushed and its isolated preview was verified at 320, 375, 390, 430, 768, 1024, and 1440 px without horizontal overflow.

In progress:

- Production game cards for MTT, NLH cash, PLO variants, Spins, and Heads Up.
- Each family needs desktop and mobile templates, dynamic data, live states, semantic actions, accessibility, and responsive behavior.

Blocked / not yet approved:

- No production game-card implementation is approved or shipped.
- The active top-three branch is not merged to `main` in this handoff.
- Final rendered QA against a stable deployment is still required after game cards are implemented.

## Locked boundaries

- Do not alter protected live poker gameplay or `TablePage` as part of this work.
- Do not globally replace shared buttons outside Club Arena.
- Do not modify the approved club card, BBJ plaque, or wallet visuals without explicit approval.
- Do not put dynamic values into images.
- Do not replace existing realtime, wallet, role, registration, seat, or navigation logic.
- Do not publish game cards before the user approves a rendered mockup.

## Non-Negotiable Visual Approval Gate

Every Club Arena visual change must stop at a green pull request until the user explicitly approves representative rendered images. Before enabling auto-merge or publishing:

1. Render and show both desktop and mobile compositions in the chat.
2. State clearly that the branch is green but not shipped.
3. Wait for an explicit user approval of those renders.
4. Only then enable merge and follow the production publish through verification.

Pushing a branch for CI is allowed, but auto-merge must remain disabled until approval. Passing checks, silence, an earlier approval of a different render, or a request to report when green is not permission to merge or publish.

## Current release evidence

- Branch commit: `a01d21c3cd8d6f874895d220b838bdfd0dd805fa`
- Vercel preview: `https://clubbuttons-readiness-preview-b20n6s4vd-smarter-poker.vercel.app`
- Club route used for QA: `/hub/club-arena/clubs/25450`
- Local checks at checkpoint: TypeScript passed, focused Vitest passed (9 tests), full production build passed.
- Existing repository CSS warnings were present and were not caused by this Club Arena work.

## Exact next action

Build one mobile-first production game-card family at a time, beginning with MTT. Use the approved pair of MTT references, fill it with realistic maximum-length live data, render at 320/375/390/430 and desktop widths, and obtain approval before wiring or publishing the remaining four families. Preserve existing `ClubHomePage` row filtering and actions.

## External or missing material

The key approved references and directives have been copied into the repository. The original Desktop file named `Screenshot 2026-08-28 at 6.35.38 PM.png` was no longer present when archived. Its design is materially represented by the checked-in runtime lobby chassis and campaign artwork; retrieve the original from the prior account/chat only if pixel-level provenance is required.
