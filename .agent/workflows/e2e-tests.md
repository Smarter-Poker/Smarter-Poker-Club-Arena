---
description: How to run E2E tests with Playwright
---

# Running E2E Tests

## Prerequisites

Playwright and Chromium are already installed.

## Quick Run

// turbo

```bash
npm run test:e2e
```

## With UI Mode

```bash
npm run test:e2e:ui
```

## Run Specific Test File

```bash
npx playwright test e2e/basic.spec.ts
```

## Headed Mode (See Browser)

```bash
npx playwright test --headed
```

## Debug Mode

```bash
npx playwright test --debug
```

## Generate Report

// turbo

```bash
npx playwright show-report
```

## Test files:

- `e2e/basic.spec.ts` - Auth + navigation tests
- `e2e/operations.spec.ts` - Club, table, wallet tests
- `e2e/features.spec.ts` - Tournament, leaderboard, etc.
