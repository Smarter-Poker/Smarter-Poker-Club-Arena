# Next Steps

## 2026-08-29 completion note

The five-family local replacement is complete and approved: MTT, NLH cash,
PLO, Spins, and Heads Up now resolve to their V2 premium desktop/mobile skins.
The dynamic action-state matrix, focused tests, build, stress rendering, and all
required breakpoint checks are complete. No preview was published from this
worktree because its build provenance reports it is 18 commits behind
`origin/main`; reconcile that branch state before any deployment.

## Immediate, in order

1. Open the MTT A/B references and the exact game-card directive.
2. Inventory existing `ClubHomePage` tournament row data and actions; do not replace them.
3. Create one MTT desktop template and one mobile template with semantic overlays.
4. Populate maximum-length representative values and all meaningful states.
5. Render at 320, 375, 390, 430, 768, 1024, and 1440 px.
6. Show the rendered MTT mockup to the user before pushing or publishing.
7. After approval, repeat for NLH, PLO variants, Spins, and Heads Up.
8. Add focused component tests and run TypeScript, Vitest, full build, and rendered QA.
9. Deploy an accessible Vercel preview and verify the real Club Arena route.
10. Only then request merge of the game-card phase.

## Short term

- Open/merge the current `codex/club-lobby-command-top` branch if its latest checks are green.
- Verify role-aware wallet rows for every supported club role without changing their locked art.
- Add screenshot regression coverage for the command top and each approved card family.

## Medium term

- Begin Club Arena Pass 1 migration only after the full rendered gate passes.
- Do not migrate World Hub or Club Commander until Club Arena is approved and the shared API is stable.

## Nice to have

- Normalize historical rejected asset metadata.
- Move large source masters to Git LFS only after repository-owner approval and deployment verification.
- Add a gallery route dedicated to approved/rejected visual provenance.
