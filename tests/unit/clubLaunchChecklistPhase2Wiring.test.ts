/**
 * Create A Club, Phase 2 (2026-09-20): the lobby side of the opening checklist.
 *
 * Source pins for ClubHomePage, which is too heavy to mount for each of these,
 * plus direct tests of the pure helpers it exports.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shouldCelebrateClubLevelUp } from '../../src/pages/ClubHomePage';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const PAGE = read('src/pages/ClubHomePage.tsx');
const ACTIONS = read('src/components/club/GameCreationActions.tsx');
const ACTIONS_CSS = read('src/components/club/GameCreationActions.module.css');
const CREATE_TABLE = read('src/pages/CreateTablePage.tsx');
const MANAGEMENT = read('src/pages/GameManagementPage.tsx');
const COMMAND_CSS = read('src/components/lobby/ClubLobbyCommandTop.css');
const COMMAND_TOP = read('src/components/lobby/ClubLobbyCommandTop.tsx');

describe('create controls fail closed on union scope', () => {
  it('renders the lobby create control only behind the fail-closed gate', () => {
    expect(PAGE).toContain(
      "const canCreateClubGames = noticeEditable && clubUnionScope === 'standalone'"
    );
    const gate = PAGE.indexOf('{canCreateClubGames && (');
    const control = PAGE.indexOf('<GameCreationActions');
    expect(gate).toBeGreaterThan(-1);
    expect(control).toBeGreaterThan(gate);
    expect(PAGE.slice(gate, control).trim()).toBe('{canCreateClubGames && (');
    /* One mount, so there is no second, ungated control. */
    expect(PAGE.split('<GameCreationActions').length - 1).toBe(1);
  });

  it('leaves the lookup unresolved, never null, when it errors with nothing to fall back on', () => {
    const errorBranch = PAGE.slice(
      PAGE.indexOf('if (ucErr) {'),
      PAGE.indexOf('if (!ucErr && !ucRow) {')
    );
    expect(errorBranch).toContain('setUnionIdForCreate(fallback)');
    expect(errorBranch).not.toContain('setUnionIdForCreate(null)');
    expect(PAGE).toContain('useState<string | null | undefined>(undefined)');
  });

  it('refuses the checklist create actions while scope is unresolved, with an honest message', () => {
    expect(PAGE).toContain('Club Setup Is Still Loading. Try Again In A Moment.');
    expect(PAGE).toContain('This Club Is Managed By A Union. Create Games From The Union Console.');
  });
});

describe('create control per category', () => {
  const block = PAGE.slice(
    PAGE.indexOf('const CREATE_TABLE_GAME_FOR_TAB'),
    PAGE.indexOf('const SORT_OPTIONS')
  );
  const targets = PAGE.slice(
    PAGE.indexOf('const CREATE_TARGET_FOR_TAB'),
    PAGE.indexOf('const CREATE_TABLE_GAME_FOR_TAB')
  );

  it('gives each cash tab its own variant, and every id is one Table Management accepts', () => {
    expect(block).toContain("HOLDEM: 'nlh'");
    expect(block).toContain("OMAHA: 'plo4'");
    expect(block).toContain("LIMIT: 'flh'");
    for (const id of ['nlh', 'plo4', 'flh']) {
      expect(CREATE_TABLE).toContain(`id: '${id}',`);
    }
    expect(MANAGEMENT).toContain("const gameParam = searchParams.get('game');");
    expect(MANAGEMENT).toContain('isCreateTableGameType(gameParam)');
    expect(PAGE).toContain('tableGame={CREATE_TABLE_GAME_FOR_TAB[gameType]}');
  });

  it('keeps MTT, Spins and Heads Up on their own targets and gives ALL none', () => {
    expect(targets).toContain('ALL: null,');
    expect(targets).toContain("MTT: 'event',");
    expect(targets).toContain("SPIN: 'spin',");
    expect(targets).toContain("SNG: 'sng',");
    expect(targets).toContain("HOLDEM: 'table',");
    expect(targets).toContain("OMAHA: 'table',");
    expect(targets).toContain("LIMIT: 'table',");
    expect(block).not.toMatch(/ALL|MTT|SPIN|SNG/);
  });

  it('adds the variant to the table link only, and stays desktop only in the lobby', () => {
    expect(ACTIONS).toContain("action.target === 'table' && tableGame");
    expect(ACTIONS).toContain('`${path}&game=${encodeURIComponent(tableGame)}`');
    /* Dan 2026-09-02: desktop only. Unchanged by this work. */
    expect(PAGE).toMatch(/<GameCreationActions[\s\S]{0,260}desktopOnly\s/);
    expect(ACTIONS_CSS).toMatch(
      /@media \(max-width: 900px\) \{\s*\.desktopOnly \{\s*display: none;/
    );
  });
});

describe('opening checklist wiring', () => {
  it('marks the setup wizard required and the other ten steps optional', () => {
    const list = PAGE.slice(
      PAGE.indexOf('const launchTaskList: ClubLaunchTask[] = ['),
      PAGE.indexOf('const launchTasks = resolveClubLaunchTasks(')
    );
    const steps = list.split(/\n {4}\{\n/).slice(1);
    expect(steps).toHaveLength(11);
    expect(steps[0]).toContain("id: 'opening-setup'");
    expect(steps[0]).not.toContain('optional');
    for (const step of steps.slice(1)) expect(step).toContain('optional: true,');
  });

  it('resolves skips once, in the lobby, and hands the same state to the checklist', () => {
    expect(PAGE).toContain("useClubLaunchSkips(club?.id ?? '', currentUserId || 'unknown')");
    expect(PAGE).toContain(
      'const launchTasks = resolveClubLaunchTasks(launchTaskList, launchSkips.skippedIds);'
    );
    expect(PAGE).toContain('skips={launchSkips}');
    expect(PAGE).toContain('data-opening-checklist={showLaunchChecklist || undefined}');
  });

  it('shows the opening journey to the owner, whose state is the only one loaded', () => {
    const show = PAGE.slice(
      PAGE.indexOf('const showLaunchChecklist ='),
      PAGE.indexOf('return (', PAGE.indexOf('const showLaunchChecklist ='))
    );
    expect(show).toContain('isOwner &&');
    expect(show).not.toContain('noticeEditable');
  });

  it('counts a placeholder crest as no picture', () => {
    expect(PAGE).toContain('complete: hasOwnClubPicture(club),');
    expect(PAGE).not.toContain('complete: Boolean(club.logo_url || club.avatar_url)');
  });

  it('passes the saved tag line to the opening wizard', () => {
    expect(PAGE).toContain('initialTagline={club.tagline ?? null}');
  });

  it('retries a failed setup read once now and once on the next natural refresh, with no timer', () => {
    const effect = PAGE.slice(
      PAGE.indexOf('const readSetupState = (attempt: 1 | 2)'),
      PAGE.indexOf('openingChecklistEligible, openingSetupReadRevision]);')
    );
    expect(effect).toContain(
      "reportError(error, 'ClubHomePage.Opening_setup_state', { attempt });"
    );
    expect(effect).toContain('if (attempt === 1) return readSetupState(2);');
    expect(effect).toContain('openingSetupReadFailedRef.current = true;');
    expect(effect).not.toMatch(/setTimeout|setInterval/);
    const refresh = PAGE.slice(
      PAGE.indexOf('useVisibilityRefresh(() => {'),
      PAGE.indexOf('const navigate = useAppNavigate();')
    );
    expect(refresh).toContain('openingSetupReadFailedRef.current = false;');
    expect(refresh).toContain('return loadClubData();');
    expect(PAGE.split('useVisibilityRefresh(').length - 1).toBe(1);
  });
});

describe('desktop checklist scrollport', () => {
  it('keeps focused items clear of the pinned Find Your Game deck', () => {
    expect(COMMAND_CSS).toMatch(
      /\.club-lobby-machine\[data-opening-checklist='true'\]\s*\{[^}]*scroll-padding-top:\s*var\(--ca-lobby-controls-h, 0px\);/
    );
    /* The variable is real: measured and published on every viewport. */
    expect(COMMAND_TOP).toContain("const LOBBY_CONTROLS_HEIGHT_VAR = '--ca-lobby-controls-h';");
  });
});

describe('level-up celebration', () => {
  it('celebrates a real rise between two like-for-like counts', () => {
    expect(
      shouldCelebrateClubLevelUp({ level: 2, source: 'live' }, { level: 3, source: 'live' })
    ).toBe(true);
    expect(
      shouldCelebrateClubLevelUp(
        { level: 4, source: 'union-total' },
        { level: 5, source: 'union-total' }
      )
    ).toBe(true);
    expect(
      shouldCelebrateClubLevelUp({ level: 1, source: 'row' }, { level: 2, source: 'row' })
    ).toBe(true);
  });

  it('ignores a rise that follows a failed or fallback read', () => {
    /* Union total unreadable -> the club's own count -> a good read again. */
    expect(
      shouldCelebrateClubLevelUp(
        { level: 2, source: 'fallback' },
        { level: 6, source: 'union-total' }
      )
    ).toBe(false);
    expect(
      shouldCelebrateClubLevelUp({ level: 2, source: 'live' }, { level: 6, source: 'union-total' })
    ).toBe(false);
    expect(
      shouldCelebrateClubLevelUp({ level: 2, source: 'live' }, { level: 3, source: 'fallback' })
    ).toBe(false);
    expect(
      shouldCelebrateClubLevelUp({ level: 2, source: null }, { level: 3, source: 'live' })
    ).toBe(false);
  });

  it('never celebrates a first load, a level zero, or no rise', () => {
    expect(shouldCelebrateClubLevelUp(null, { level: 3, source: 'live' })).toBe(false);
    expect(
      shouldCelebrateClubLevelUp({ level: 0, source: 'live' }, { level: 3, source: 'live' })
    ).toBe(false);
    expect(
      shouldCelebrateClubLevelUp({ level: 3, source: 'live' }, { level: 3, source: 'live' })
    ).toBe(false);
  });

  it('is what the page uses, with the source recorded beside the committed level', () => {
    expect(PAGE).toContain('const celebrateLevelUp = shouldCelebrateClubLevelUp(');
    expect(PAGE).toContain('clubLevelSourceRef.current = memberCountSource;');
    expect(PAGE).toContain("memberCountSource = 'union-total';");
    expect(PAGE.split("memberCountSource = 'fallback';").length - 1).toBe(3);
    expect(PAGE).not.toContain(
      'previousLevel && previousLevel.level > 0 && levelInfo.level > previousLevel.level'
    );
  });
});
