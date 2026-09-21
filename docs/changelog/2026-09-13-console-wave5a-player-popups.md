# 2026-09-13: console wave 5a, nine player popups on the spade console

Batch of the #ClubArenaConsole sweep (branch
`feat/console-wave5-popups-pages`, off `main` while #3886 waits on checks).
Standard: `.claude/skills/club-arena-console/SKILL.md`.

Rebuilt on `SpadeConsole`: VIP Cards (`crest="vip"`, Join Membership on a
plate opening the same URL with the same tab policy), Diamond Wallet
(`crest="diamond"`, filters as lit words, receipts as rows, amounts exact),
Bad Beat Jackpot info (pool as the engraved title, every pinned literal kept
verbatim), Identity (alias switch as a lit ON/OFF word, `role="switch"`
kept), Club Profile (felt money never abbreviated: the test pins
`2,450.50`), Tournament Lobby (Dan's 3/4-sheet geometry kept, console
inside it), Referral, Terms Of Service (scroll-to-bottom gate kept, Dan's
chips sentence verbatim), and the Maintenance Break banner (brand-inked,
not framed: a banner is not a card).

Skipped on the ruling that a surface on another approved master is finished
work: Diamond Top-Up is #SmarterCasinoRealism and pinned by
`tests/e2e/diamond-checkout-mobile.spec.ts`.

Retained generic rules that other, not-yet-rebuilt surfaces still consume:
`AgeGate` shares `TOSAcceptanceModal.css`; `MustMoveLobbyModal` borrows
`tlm-*` from `TournamentLobbyModal.css`. They come out when those are
rebuilt.

Kit: the harness template now loads Roboto Condensed and Inter from Google
Fonts the way `index.html` does; two agents in this wave had to patch their
copies by hand before the fitted labels measured correctly.

Gates: five copy/CSS checks OK, `tsc` clean, 23 test files / 363 tests
green in the worktree. Renders at 393px, before beside after, in the
session's `wave5a/` folder.
