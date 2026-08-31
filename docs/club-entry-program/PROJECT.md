# Club Entry Program

## Vision

Turn Create a Club, Find a Player, and Join a Club into secure, measurable,
fast, accessible, and cinematic entry points to Club Arena without weakening
the existing Supabase permission model or established business logic.

## Users

- Players joining clubs and locating permitted contacts.
- Club owners creating and configuring organizations.
- Agents and club/union staff searching their authorized network.
- Support and operations staff diagnosing failed or abusive workflows.

## Technical Context

- React 19 + TypeScript + Vite 6 Club Arena SPA.
- Supabase PostgreSQL, RLS, RPC functions, Realtime, and Storage.
- Zustand state, Master Bus events, Vitest, and Playwright.
- Deployed below `/hub/club-arena/` inside the Smarter.Poker World Hub.

## Non-negotiable Constraints

- Permission and membership rules are server-authoritative.
- Dynamic data remains HTML/application data, never baked into artwork.
- No phase is complete until its tests and phase-specific verification pass.
- Existing unrelated worktree changes are preserved.
- Expensive artwork must have responsive, optimized delivery variants.

## Success

- Each action is keyboard, touch, and screen-reader operable.
- Create and Join operations are atomic and idempotent.
- Player search is server-authoritative, cancellable, paginated, and indexed.
- Failures are actionable, monitored, and measurable by stage.
- Core flows pass role-based unit, integration, and browser tests.
