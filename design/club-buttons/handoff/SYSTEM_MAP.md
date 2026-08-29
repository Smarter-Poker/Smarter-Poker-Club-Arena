# System Map

## Applications and routes

- Vite/React Club Arena application in this repository.
- Club lobby page: `src/pages/ClubHomePage.tsx`.
- Club Arena route pattern: `/hub/club-arena/clubs/:clubId`.
- Development gallery: `/hub/club-arena/dev/club-ui` where enabled.

## UI layers

1. `design/club-buttons/`: specifications, masters, references, prompts, and handoff.
2. `public/assets/club-buttons/`: deployable artwork.
3. `src/components/club-buttons/`: canonical reusable semantic controls.
4. `src/components/lobby/ClubLobbyCommandTop.*`: joined command-top layout.
5. `src/pages/ClubHomePage.tsx`: live Club Arena orchestration, data, filters, and actions.

## Data and services

- Supabase supplies club metadata, memberships, wallet data, tables/tournaments, BBJ pools, and realtime updates.
- Existing role and wallet-row rules decide which of the nine wallet families a user sees.
- Existing lobby actions own registration, seating, watching, details, and navigation.
- Vercel builds and hosts the web preview/production surface.

## Local workflow

```text
npm install
npm run dev
npm run typecheck
npm test
npm run build
npm run preview
```

Use `.env.example` as the variable-name guide. Never copy secrets into documentation. Deployment rewrites live in `vercel.json`; the Club Arena base-path/font behavior is load-bearing.

## Branching

- `main` is protected product history.
- Feature work uses a scoped `codex/` branch.
- Earlier mixed work is preserved separately; do not cherry-pick it wholesale because it includes protected gameplay changes.
