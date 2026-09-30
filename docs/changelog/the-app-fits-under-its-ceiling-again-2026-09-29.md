# The app fits under its size ceiling again (2026-09-29)

**What was wrong.** Every pull request that added code failed the required
Production Build check, whatever it did: main alone measured 2,880.5 kB
gzipped against the 2,880 kB whole-app ceiling in `scripts/ci/bundle-size.mjs`
(#5623 and #5627 both measured 2,881 kB in CI).

**Why.** The website carried code only the phone app can ever run: the share
sheet, the phone's haptic engine and the app-store purchase module, with the
Capacitor plugins behind them - 13 files, about 16 kB gzipped. Every import of
that code already sat behind `IS_NATIVE_BUILD`, the build constant that is
false on the web, so the web build should have dropped it. It did not, because
each import was written inside a `try` block, and Rollup (Vite's bundler) keeps
everything inside a `try` block whatever a constant says (its default
`treeshake.tryCatchDeoptimization`).

**Fix.** Seven call sites in five files (`src/utils/vibrationGate.ts` twice,
`src/components/stats/StatsShareCard.tsx`,
`src/components/achievements/AchievementShareCard.tsx`,
`src/pages/SettingsPage.tsx`, `src/pages/marketplace/MembershipTab.tsx` twice)
now call a small module-level helper that returns at once when
`!IS_NATIVE_BUILD` and otherwise does exactly what the old line did. Nothing
changes for anyone: each call site was already behind `IS_NATIVE_BUILD && ...`,
so the web never ran those lines, and the app build runs the same statements
as before.

**Measured** with the Production Build job's own build and environment
(node 20):

|             | gzipped     | raw          | files |
| ----------- | ----------- | ------------ | ----- |
| main before | 2,880.48 kB | 10,136.16 kB | 595   |
| after       | 2,864.51 kB | 10,092.78 kB | 582   |

The ceiling is unchanged (2,880 kB gzipped, 10,150 kB raw), and so is the
initial load (314 kB gzipped).

**For next time.** Code that must stay out of the website must not have its
`import()` written inside a `try` block. Put the import in a helper that checks
`IS_NATIVE_BUILD` first - `fireNativeHaptic` in `src/utils/vibrationGate.ts` is
the pattern.
