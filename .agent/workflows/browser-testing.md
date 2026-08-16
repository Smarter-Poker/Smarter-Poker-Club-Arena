---
description: How to test features in the browser — ALL testing on smarter.poker ONLY
---

# Browser Testing Workflow — Club Arena

> **MANDATORY LAW — ZERO EXCEPTIONS**
>
> ALL browser testing and UI verification MUST be performed on the **live production site**:
>
> **`https://smarter.poker/hub/club-arena/`**
>
> **NEVER** test on:
>
> - `localhost:5173` or any localhost URL
> - `localhost:3000` or any dev server
> - `club-arena.vercel.app` or any Vercel preview URL
> - `club-engine.vercel.app` or any legacy deployment
>
> The dev server and Vercel preview apps exist for build verification ONLY — not for browser testing.
>
> Any agent that opens a browser to localhost or a Vercel app URL for testing is in VIOLATION of this standard.

## Test Account Credentials

- **Email:** `daniel@bekavactrading.com`
- **Password:** `<TEST_USER_PASSWORD — see .env.local, never commit>`

## Login Steps

1. Navigate to `https://smarter.poker/hub/club-arena/` (or the specific page you need to test)
2. If prompted with "Sign In Required", click the sign-in / login button
3. Enter the email and password above
4. Wait for the session to initialize (usually 2-5 seconds)
5. Proceed with testing

## Why Production Only?

- The local dev server does NOT have the same environment, data, or auth state as production
- Features that "work on localhost" often break in production due to missing env vars, RLS policies, edge caching, etc.
- Testing on production catches REAL bugs — testing on localhost gives false confidence
- The user deploys continuously; by the time you test localhost, the code is already live
- Club Arena is served from smarter.poker's `public/hub/club-arena/` — testing on localhost tests a DIFFERENT build pipeline

## What Localhost Is For

The ONLY acceptable use of `localhost:5173` is:

- Running `npm run build` to verify compilation
- Running `npx tsc --noEmit` to check TypeScript
- Running `npm run dev` to confirm the dev server starts (health check only)

You MUST NOT open a browser to localhost for visual verification, feature testing, or screenshots.

## Notes

- This account has access to all features and should bypass all gates (FeatureGate, BankrollProGate, etc.)
- Do **NOT** use temporary code bypasses for gates — always log in with this account instead
- For API endpoint testing (curl/fetch), you may use `https://smarter.poker/api/...` directly
