/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: EVERY FILE UNDER src/ IS REACHABLE FROM THE ENTRY, OR IT IS LISTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Audit 2026-09-08, CL-55: 286 behavioural files (27,335 lines) under src/
 * were unreachable from index.html -> src/main.tsx. The existing orphan
 * ratchet (scripts/ci/report-orphan-modules.mjs) counts files that nothing
 * IMPORTS, and 73 of the orphans were re-export barrels - so about 130
 * components of one unused design-system layer looked imported (by a barrel)
 * while nothing reached the barrel. Direct import counting cannot see a dead
 * subtree; a walk from the entry can.
 *
 * On 2026-09-10 the walk found 474 unreachable files (CSS included) and 391
 * were deleted. What this law does:
 *
 *   1. Walks from index.html's /src/ references and vite.config.ts's src/
 *      entries across static and dynamic imports, re-exports, CSS @import
 *      and url(/src/...), through the vite aliases. Comments are NOT
 *      stripped, so a path named only in a comment keeps a file alive - the
 *      walk errs toward "reachable".
 *   2. Every file under src/ that the walk does not reach must be in
 *      RETAINED below, with the reason it is still here. Today every reason
 *      is "a test, law, ratchet or CI script reads it by path"; deleting one
 *      of those means retargeting the reader in the same commit.
 *   3. RETAINED has no ghosts and never lists a reachable file, so the list
 *      only ever shrinks.
 *
 * If a NEW file is reported here: either wire it into the app (the usual
 * answer - a component nothing renders is not shipped) or, if it is reached
 * by a mechanism this walk cannot see (import.meta.glob, a worker URL), add
 * it to RETAINED with that reason. Never add "will be used later".
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');

/** Unreachable today, each with the reader that still names it by path. */
const RETAINED: Record<string, string> = {
  'src/assets/customization-thumbs/sources.json':
    'read by path: scripts/lib/customization-thumbnail-policy.mjs',
  'src/components/ClubLogoSelector.css': 'imported only by another retained file',
  'src/components/ClubLogoSelector.tsx':
    'read by path: tests/config/themeAndSkinIdsAreReal.test.ts',
  'src/components/Shell.css': 'imported only by another retained file',
  'src/components/Shell.tsx':
    'read by path: tests/approvedHamburgerGearGuard.law.test.ts tests/the-section-rail-shows-its-own-edge.law.test.ts',
  'src/components/admin/AdminCommandPalette.tsx':
    'read by path: scripts/ci/check-nav-title-case.mjs scripts/ci/check-title-case.mjs',
  'src/components/admin/SecurityDashboard.tsx': 'imported only by another retained file',
  'src/components/agent/AgentHierarchyTree.css': 'imported only by another retained file',
  'src/components/agent/AgentHierarchyTree.tsx': 'imported only by another retained file',
  'src/components/agent/index.ts': 'read by path: tests/the-last-wrong-account-path.law.test.ts',
  'src/components/club/TableOperationsPanel.tsx':
    'read by path: tests/unit/managedGameLifecycleAuthority.test.ts',
  'src/components/customization/index.ts':
    'read by path: tests/config/cardBackIdsAreReal.test.ts tests/unit/noUnreachableSettingsUi.test.ts',
  'src/components/counters/AnimatedCounter.css': 'imported only by another retained file',
  'src/components/counters/AnimatedCounter.tsx':
    'read by path: tests/a-stale-read-never-lands.law.test.ts',
  'src/components/emoji/EmojiPicker.css': 'read by path: scripts/ci/check-no-emoji.mjs',
  'src/components/emoji/EmojiPicker.tsx':
    'read by path: scripts/ci/check-no-emoji.mjs tests/no-emoji-gate.test.ts',
  'src/components/feedback/RatingModal.css': 'imported only by another retained file',
  'src/components/feedback/RatingModal.tsx': 'imported only by another retained file',
  'src/components/feedback/index.ts': 'read by path: tests/tip-dealer-guards.test.tsx',
  'src/components/gamification/LuckyDrawWheel.css':
    'dead wheel; on the Math.random allowlist of a-player-is-never-shown-an-invented-number, delete both together',
  'src/components/gamification/LuckyDrawWheel.tsx':
    'dead wheel; on the Math.random allowlist of a-player-is-never-shown-an-invented-number, delete both together',
  'src/components/moderation/ReportPlayerModal.css': 'imported only by another retained file',
  'src/components/moderation/ReportPlayerModal.tsx':
    'read by path: scripts/ci/check-nav-title-case.mjs scripts/ci/check-title-case.mjs',
  'src/components/navigation/FloatingHamburger.module.css':
    'read by path: tests/approvedHamburgerGearGuard.law.test.ts',
  'src/components/navigation/FloatingHamburger.tsx':
    'read by path: tests/approvedHamburgerGearGuard.law.test.ts',
  'src/components/navigation/NotificationDropdown.module.css':
    'imported only by another retained file',
  'src/components/navigation/NotificationDropdown.tsx':
    'read by path: tests/unit/discardedErrorReadRatchet.test.ts',
  'src/components/navigation/QuickActionsBar.module.css': 'imported only by another retained file',
  'src/components/navigation/QuickActionsBar.tsx':
    'read by path: scripts/ci/check-nav-title-case.mjs tests/unit/navigationSurfacesLaw.test.ts',
  'src/components/notifications/InAppAlerts.css': 'imported only by another retained file',
  'src/components/notifications/InAppAlerts.tsx': 'imported only by another retained file',
  'src/components/notifications/NotificationItem.css':
    'read by path: tests/no-hover-effects.law.test.ts',
  'src/components/players/PlayerNotes.css': 'read by path: tests/no-hover-effects.law.test.ts',
  'src/components/promotions/PromotionDetail.css': 'imported only by another retained file',
  'src/components/promotions/PromotionDetail.tsx':
    'read by path: tests/unit/phase8ClubControl.test.ts',
  'src/components/search/RecentSearches.css': 'read by path: tests/no-hover-effects.law.test.ts',
  'src/components/security/PasswordStrength.css': 'imported only by another retained file',
  'src/components/security/PasswordStrength.tsx':
    'read by path: scripts/ci/check-nav-title-case.mjs scripts/ci/check-title-case.mjs',
  'src/components/social/OnlineFriendsPill.css': 'imported only by another retained file',
  'src/components/social/OnlineFriendsPill.tsx':
    'read by path: tests/unit/arenaAvatarSeparation.test.ts tests/unit/discardedErrorReadRatchet.test.ts',
  'src/components/social/PresenceIndicator.module.css': 'imported only by another retained file',
  'src/components/social/PresenceIndicator.tsx':
    'read by path: tests/unit/discardedErrorReadRatchet.test.ts',
  'src/components/stats/StatCard.css': 'imported only by another retained file',
  'src/components/stats/StatCard.tsx': 'imported only by another retained file',
  'src/components/stats/StatGrid.css': 'imported only by another retained file',
  'src/components/stats/StatGrid.tsx': 'imported only by another retained file',
  'src/components/stats/index.ts': 'read by path: tests/stats-phase-2-one-chunk-per-tab.test.ts',
  'src/components/support/FAQPanel.css': 'imported only by another retained file',
  'src/components/support/FAQPanel.tsx': 'read by path: scripts/ci/check-title-case.mjs',
  'src/components/table/EmojiPicker.css': 'read by path: scripts/ci/check-no-emoji.mjs',
  'src/components/tables/SortableTable.css': 'imported only by another retained file',
  'src/components/tables/SortableTable.tsx':
    'read by path: tests/a-stale-read-never-lands.law.test.ts',
  'src/components/table/EmojiPicker.tsx':
    'read by path: scripts/ci/check-no-emoji.mjs tests/config/realtimePurchaseFulfillment.test.ts tests/no-emoji-gate.test.ts',
  'src/components/table/MiniStatsCard.css': 'imported only by another retained file',
  'src/components/table/MiniStatsCard.tsx':
    'read by path: tests/unit/tournamentTableFixes.test.tsx tests/unit/tourneyUxSweep20260825.test.tsx',
  'src/components/table/PremiumCard.css': 'read by path: tests/shipped-invariants.test.ts',
  'src/components/table/PremiumCard.tsx':
    'read by path: tests/config/canonicalPremiumCards.test.ts',
  'src/components/table/SpectatorOverlay.css': 'imported only by another retained file',
  'src/components/table/SpectatorOverlay.tsx': 'read by path: tests/shipped-invariants.test.ts',
  'src/components/tooltips/Tooltip.css': 'read by path: scripts/ci/entry-chunk-baseline.json',
  'src/components/tooltips/Tooltip.tsx':
    'read by path: tests/unit/touchCanReachHoverOnlyData.test.ts',
  'src/components/training/RangeViewer.css': 'imported only by another retained file',
  'src/components/training/RangeViewer.tsx':
    'read by path: tests/unit/touchCanReachHoverOnlyData.test.ts',
  'src/components/waitlist/WaitlistManager.css': 'imported only by another retained file',
  'src/components/waitlist/WaitlistManager.tsx':
    'read by path: tests/unit/discardedErrorReadRatchet.test.ts tests/unit/waitlistWritePaths.test.ts',
  'src/components/wallet/index.ts': 'read by path: tests/wallet-display-ledger.test.ts',
  'src/config/headsUpSpec.ts':
    'read by path: server/src/config/headsUpSpec.ts server/src/services/TournamentRecurringService.ts supabase/migrations/20260831164500_heads_up_rake_is_five_percent_not_a_convention.sql',
  'src/constants/index.ts': 'read by path: tests/unit/theAppDoesNotLieToPlayers.test.ts',
  'src/constants/limits.ts': 'imported only by another retained file',
  'src/constants/timing.ts': 'imported only by another retained file',
  'src/core/AntiGravityBoot.tsx': 'read by path: tests/unit/AntiGravityBoot.test.ts',
  'src/core/SupabaseIntegration.ts': 'read by path: tests/unit/SupabaseIntegration.test.ts',
  'src/i18n/index.ts': 'read by path: scripts/ci/check-title-case.mjs',
  'src/lib/diamondArenaIdentity.ts': 'read by path: tests/poker-arena-access.test.ts',
  'src/pages/ClubDetailPage.module.css': 'imported only by another retained file',
  'src/pages/ClubDetailPage.tsx':
    'read by path: tests/promotion-assigns-the-rate.law.test.ts tests/theArenaIsAlwaysTheAlias.law.test.ts tests/unit/CompleteSetReadsDoNotTruncate.test.ts',
  'src/services/ChipFlowService.ts':
    'read by path: supabase/migrations/20260902130000_the_dead_pool_stops_taking_deposits.sql tests/cashier-ui-role-scoping.test.ts tests/config/roleScopedCashier.test.ts',
  'src/services/ClubMessagingPermissions.ts':
    'read by path: tests/promotion-assigns-the-rate.law.test.ts tests/unit/ClubMessagingPermissions.test.ts',
  'src/styles/design-system.css': 'documentation anchor: 47 live stylesheets cite it in comments',
  'src/utils/clubThemeEngine.ts': 'read by path: tests/unit/clubThemeEngine.test.ts',
  'src/utils/formatTimeAgo.ts': 'read by path: tests/unit/formatTimeAgo.test.ts',
  'src/utils/memberCount.ts':
    'read by path: tests/member-count-truth.test.ts tests/unit/sourceGrepReporter.test.ts tests/unit/tableSeatsCountNamesAColumn.test.ts',
  'src/utils/subscriptionMonitor.ts':
    'read by path: tests/unit/realtime-channel-service.test.ts tests/unit/subscriptionMonitor.test.ts',
};

const ALIASES: Record<string, string> = {
  '@components/': 'src/components/',
  '@lib/': 'src/lib/',
  '@hooks/': 'src/hooks/',
  '@stores/': 'src/stores/',
  '@types/': 'src/types/',
  '@services/': 'src/services/',
  '@arena/': 'src/arena/',
  '@/': 'src/',
};
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.json'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const ALL = new Set(walk(SRC).filter((f) => /\.(tsx?|jsx?|mjs|css|json)$/.test(f)));

function resolveSpec(fromFile: string, rawSpec: string): string | null {
  const spec = rawSpec.split('?')[0];
  let base: string;
  if (spec.startsWith('.')) base = join(dirname(fromFile), spec);
  else if (spec.startsWith('/src/')) base = join(ROOT, spec);
  else {
    const alias = Object.keys(ALIASES).find((k) => spec.startsWith(k));
    if (!alias) return null;
    base = join(ROOT, ALIASES[alias], spec.slice(alias.length));
  }
  base = normalize(base);
  const candidates = [
    base,
    ...EXTS.map((e) => base + e),
    ...EXTS.map((e) => join(base, 'index' + e)),
  ];
  for (const c of candidates) if (ALL.has(c)) return c;
  return null;
}

const IMPORT_RE =
  /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|@import\s+(?:url\()?['"]([^'"]+)['"]|url\(\s*['"]?(\/src\/[^'")]+)['"]?\s*\)/g;

function deps(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(text))) {
    const r = resolveSpec(file, m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]);
    if (r) out.push(r);
  }
  return out;
}

function roots(): Set<string> {
  const out = new Set<string>();
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/["'](\/src\/[^"']+)["']/g)) {
    const r = resolveSpec(ROOT, m[1]);
    if (r) out.add(r);
  }
  const vite = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
  for (const m of vite.matchAll(/['"]\.?\/?src\/([^'"]+)['"]/g)) {
    const r = resolveSpec(ROOT, '/src/' + m[1]);
    if (r) out.add(r);
  }
  return out;
}

function unreachable(): string[] {
  const seen = roots();
  const queue = [...seen];
  while (queue.length) {
    const f = queue.pop()!;
    for (const d of deps(f)) {
      if (!seen.has(d)) {
        seen.add(d);
        queue.push(d);
      }
    }
  }
  return [...ALL]
    .filter((f) => !seen.has(f))
    .map((f) => relative(ROOT, f).replace(/\\/g, '/'))
    .filter((f) => !/\.(test|spec)\.[tj]sx?$/.test(f) && !/__tests__|__mocks__|\.d\.ts$/.test(f))
    .sort();
}

describe('every file under src/ is reachable from the entry, or it is listed', () => {
  const dead = unreachable();

  it('the walk starts from the real entry', () => {
    expect([...roots()].map((r) => relative(ROOT, r))).toContain('src/main.tsx');
  });

  it('no unlisted file under src/ is unreachable', () => {
    const fresh = dead.filter((f) => !(f in RETAINED));
    expect(
      fresh,
      `These files under src/ are reached by nothing from index.html -> src/main.tsx. ` +
        `Wire each one into the app, delete it, or - only if it is reached by a mechanism ` +
        `this walk cannot see - list it in RETAINED in ${relative(ROOT, __filename)} with that reason.`
    ).toEqual([]);
  });

  it('RETAINED has no ghosts', () => {
    const ghosts = Object.keys(RETAINED).filter((f) => !existsSync(join(ROOT, f)));
    expect(ghosts, 'listed files that no longer exist: remove them from RETAINED').toEqual([]);
  });

  it('RETAINED never lists a file that is reachable (the list only shrinks)', () => {
    const deadSet = new Set(dead);
    const live = Object.keys(RETAINED).filter((f) => existsSync(join(ROOT, f)) && !deadSet.has(f));
    expect(live, 'listed files that are reachable now: remove them from RETAINED').toEqual([]);
  });

  it('every retained file says why it is still here', () => {
    for (const [file, reason] of Object.entries(RETAINED)) {
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(12);
    }
  });
});
