import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Club Arena accessibility foundation', () => {
  it('removes the closed command menu from the focus tree and restores its opener', () => {
    const source = read('src/components/navigation/HamburgerMenu.tsx');

    expect(source).toContain('if (!isOpen) {');
    expect(source).toContain('return showThemeSettings ? (');
    expect(source).toContain('previousFocusRef.current.focus()');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain("event.key !== 'Tab'");
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
  });

  it('gives switches, disclosures, and the Table Studio launcher semantic controls', () => {
    const source = read('src/components/navigation/HamburgerMenu.tsx');
    const tableSettingsSource = read('src/components/table/TableSettingsPanel.tsx');

    expect(source).toContain('aria-label="Sounds"');
    expect(source).toContain('aria-label="Vibrations"');
    expect(source).toContain('role="switch"');
    expect(source).toContain('aria-expanded={showTableSettings}');
    expect(source).toContain('aria-controls={tableSettingsId}');
    expect(source).toContain('aria-label="Open Table Studio"');
    expect(source).not.toContain('aria-pressed={isSelected}');
    expect(source).not.toContain('Card Colors');
    expect(tableSettingsSource).toContain('role="switch"');
    expect(tableSettingsSource).toContain('aria-labelledby={labelId}');
    expect(tableSettingsSource).toContain('aria-busy={loading}');
    expect(tableSettingsSource).toContain('Refreshing Settings In Background...');
    expect(tableSettingsSource).not.toContain('tsp-theme-link');
  });

  it('provides skip navigation and moves focus to routed page content', () => {
    const appSource = read('src/App.tsx');
    const source = read('src/components/layouts/AppLayout.tsx');
    const mainSource = read('src/main.tsx');
    const engineStyles = read('src/styles/club-engine.css');

    expect(appSource).toContain('href="#main-content"');
    expect(source).toContain('ref={mainRef}');
    expect(source).toContain('tabIndex={-1}');
    expect(source).toContain('mainRef.current?.focus({ preventScroll: true })');
    expect(mainSource).toContain("import './styles/club-engine.css'");
    expect(engineStyles).toContain('.skip-link {');
    expect(engineStyles).toContain('transform: translateY(calc(-100% - 16px))');
    expect(engineStyles).toContain('.skip-link:focus-visible');
  });

  it('announces the spin draw and its result to a player who cannot see the disc', () => {
    /* 2026-08-31 audit. SpinWheel is `role="dialog" aria-modal="true"` and
       every moving part inside it is correctly `aria-hidden` decoration — so
       a screen reader announced "Spin Multiplier Draw, dialog" and then said
       NOTHING for the 16.6 seconds the engine holds the deal, after which the
       player was dealt into a tournament without being told what they were
       playing for. `aria-modal` made it total: assistive tech is instructed
       to ignore everything outside the dialog.

       CLAUDE.md 10.6 says a reduced-motion player loses the motion and keeps
       the MEANING. This is that law on another channel, and the wheel was
       failing it outright while BBJHitNotification — the house precedent
       asserted below — was already announcing a Bad Beat Jackpot. */
    const source = read('src/components/tournament/SpinWheel.tsx');

    expect(source).toContain('role="status"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('className="sr-only"');

    // The result must carry the three facts the visuals carry: what was
    // drawn, what it is worth, and who actually cashes.
    expect(source).toContain('Times. Prize Pool');
    expect(source).toContain('Paying ${splits}');
    expect(source).toContain("['First', 'Second', 'Third']");

    // And the dialog must not be silent while the draw is running.
    expect(source).toContain("'Drawing Your Multiplier.'");

    // The region has to exist before its text does, or several screen
    // readers miss the update entirely.
    const dialogOpen = source.indexOf('aria-modal="true"');
    const region = source.indexOf('aria-live="polite"');
    const firstPhaseBranch = source.indexOf("{phase === 'countdown' &&");
    expect(dialogOpen).toBeGreaterThan(-1);
    expect(region).toBeGreaterThan(dialogOpen);
    expect(region).toBeLessThan(firstPhaseBranch);
  });

  it('keeps the Bad Beat Jackpot announcement it was modelled on', () => {
    const source = read('src/components/bbj/BBJHitNotification.tsx');
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-live="polite"');
  });

  it('uses live-region semantics for loading and recovery states', () => {
    const source = read('src/components/common/EmptyState.tsx');

    expect(source).toContain('role={liveRole}');
    expect(source).toContain("aria-live={tone === 'error' ? 'assertive' : 'polite'}");
    expect(source).toContain('role="status"');
    expect(source).toContain('PermissionState');
  });

  it('keeps the approved fixed club footer semantic, complete, and canonically routed', () => {
    const source = read('src/components/club/ClubBottomNav.tsx');
    const accessSource = read('src/hooks/useClubNavigationAccess.ts');
    const workspaceSource = read('src/contexts/ClubWorkspaceContext.tsx');

    expect(accessSource).toContain('getClubNavigationCapabilities');
    expect(accessSource).toContain('useClubWorkspace');
    expect(workspaceSource).toContain("masterBus.subscribeDebounced('MEMBER_ROLE_CHANGED'");
    expect(workspaceSource).toContain('resolveClubUUIDStrict');
    expect(workspaceSource).toContain("await import('../utils/retryFetch')");
    expect(workspaceSource).toMatch(/retryFetch\([\s\S]*?from\('club_members'\)/);
    expect(workspaceSource).toMatch(/retryFetch\([\s\S]*?from\('profiles'\)/);
    expect(workspaceSource).toContain('CLUB_WORKSPACE_READ_TIMEOUT_MS');
    expect(workspaceSource).toContain('.abortSignal(signal)');
    expect(source).toContain("label: 'Settings'");
    expect(source).toContain("label: 'Stats'");
    expect(source).toContain("clubRoot ? `${clubRoot}/data` : '/data'");
    expect(source).toContain('aria-label="Club Arena"');
    expect(source).toContain("aria-current={activeTab === destination.key ? 'page' : undefined}");
    expect(source).toContain('data-footer-control={destination.key}');
  });

  it('uses a keyboard-native union card and explicit union loading/error states', () => {
    const source = read('src/pages/UnionsPage.tsx');

    expect(source).not.toContain('onClick={() => navigate(`/unions/${union.id}`)}');
    expect(source).toContain('aria-label={`Open ${union.name} Union`}');
    expect(source).toContain('role="progressbar"');
    expect(source).toContain('<LoadingState message="Opening Union Networks" />');
    expect(source).toContain('<ErrorState message={loadError} onRetry={loadUnions} />');
  });

  it('exposes contextual route families as a labelled current-page navigation rail', () => {
    const source = read('src/components/navigation/ArenaSectionRail.tsx');
    const layoutSource = read('src/components/layouts/AppLayout.tsx');

    expect(source).toContain('aria-label={`${section.label} Sections`}');
    expect(source).toContain("aria-current={isActive ? 'page' : undefined}");
    expect(source).toContain('<ul className={styles.items}>');
    expect(layoutSource).toContain('{showGlobalHeader && <ArenaSectionRail />}');
  });

  it('gives the club operations workspace semantic groups and a current-page rail', () => {
    const pageSource = read('src/pages/club/ClubOperationsPage.tsx');
    const railSource = read('src/components/navigation/ClubOperationsRail.tsx');
    const layoutSource = read('src/components/layouts/AppLayout.tsx');

    expect(pageSource).toContain('aria-labelledby={`ops-${group.id}`}');
    expect(pageSource).toContain('<ul className={styles.toolGrid}>');
    expect(pageSource).toContain('aria-describedby={descriptionId}');
    expect(railSource).toContain('aria-label="Club Operations Sections"');
    expect(railSource).toContain("aria-current={isActive ? 'page' : undefined}");
    expect(layoutSource).toContain('{showGlobalHeader && <ClubOperationsRail />}');
  });

  it('makes the integrity case workflow labelled, permission-aware, and keyboard operable', () => {
    const headerSource = read('src/components/club/ClubIntegrityHeader.tsx');
    const reportSource = read('src/pages/ReportReviewPage.tsx');
    const disputeSource = read('src/pages/DisputeManagementPage.tsx');
    const blacklistSource = read('src/pages/BlacklistManagerPage.tsx');

    expect(headerSource).toContain('aria-label="Integrity And Casework"');
    expect(headerSource).toContain("aria-current={item.id === active ? 'page' : undefined}");
    expect(headerSource).toContain('getClubIntegrityNavigation');
    expect(reportSource).toContain('role="dialog"');
    expect(reportSource).toContain('aria-modal="true"');
    expect(reportSource).toContain("event.key === 'Escape'");
    expect(reportSource).toContain('tabIndex={filter === item ? 0 : -1}');
    expect(reportSource).toContain('requestAnimationFrame');
    expect(disputeSource).toContain('aria-expanded={expandedId === dispute.id}');
    expect(disputeSource).toContain('tabIndex={activeTab === tab ? 0 : -1}');
    expect(disputeSource).toContain('htmlFor="dispute-search"');
    expect(blacklistSource).toContain('htmlFor="blacklist-user-id"');
    expect(blacklistSource).toContain('htmlFor="blacklist-reason"');
  });

  it('resolves public club slugs before reading or writing the UUID blacklist field', () => {
    const source = read('src/pages/BlacklistManagerPage.tsx');

    expect(source).toContain('const resolvedClubId = await resolveClubUUID(clubId)');
    expect(source).toContain(".eq('club_id', resolvedClubId)");
    expect(source).toContain('club_id: resolvedClubId');
    expect(source).not.toContain(".eq('club_id', clubId)");
  });

  it('keeps the dispute workspace from painting over the shared integrity header', () => {
    const styles = read('src/pages/DisputeManagementPage.css');

    expect(styles).not.toContain('.dispute-management-page::before');
  });
});
