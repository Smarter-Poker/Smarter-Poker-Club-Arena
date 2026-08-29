# Known Issues and Risks

- Production game cards are not implemented or approved.
- The active top-three branch is pushed but not merged in this handoff.
- The isolated Vercel preview is temporary and may not be the final production deployment.
- The original standalone lobby reference screenshot at the reported Desktop path was unavailable during archival; checked-in runtime artwork preserves the shipped design.
- Square wallet assets remain in the repository for provenance but are superseded for live lobby use.
- The repository contains many unrelated worktrees and active branches; never reset, clean, stash, or bulk-reconcile from this worktree.
- `.playwright-mcp/` and `club-lobby-top-mobile-390.png` are local QA artifacts and are intentionally not part of the product checkpoint.
- Existing CSS warnings occur during the full build; evaluate separately rather than attributing them to ClubButtons.
- Broad text searches for `XXX` and `TEMP` produce many legitimate domain terms/constants, not actionable TODOs. No ClubButtons-specific TODO/FIXME blocker was found in the scoped search.
- Game-card work touches a data-rich lobby page; accidental replacement of realtime handlers is the highest implementation risk.
- No raw credentials belong in this handoff. If a real secret is found in tracked code, revoke/rotate it and remove it through the repository's security process.
