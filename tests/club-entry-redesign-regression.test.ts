import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const home = read('src/pages/HomePage.tsx');
const actionBar = read('src/components/home/ClubEntryActionBar.tsx');
const createClub = read('src/components/modals/CreateClubModal.tsx');
const findPlayer = read('src/components/modals/FindPlayerModal.tsx');
const joinClub = read('src/components/modals/JoinClubModal.tsx');
const joinService = read('src/services/ClubJoinService.ts');
const header = read('src/components/navigation/GlobalHeader.tsx');

describe('Club Arena primary actions', () => {
  it('uses the approved action artwork with semantic controls', () => {
    expect(actionBar).toContain('aria-label="Club Arena actions"');
    expect(actionBar).toContain('aria-label="Create a Club"');
    expect(actionBar).toContain('aria-label="Find a Player"');
    expect(actionBar).toContain('aria-label="Join a Club"');
    expect(actionBar).toContain(
      "mediaUrl('images/club-arena/approved-club-entry-action-pill-v1.webp')"
    );
    expect(actionBar).toContain('alt=""');
    expect(
      existsSync(resolve(root, 'public/images/club-arena/approved-club-entry-action-pill-v1.webp'))
    ).toBe(true);
  });

  it('keeps every action wired to its existing modal state', () => {
    expect(home).toContain('setShowCreateClubModal(true)');
    expect(home).toContain('setShowFindPlayerModal(true)');
    expect(home).toContain('setShowJoinModal(true)');
  });
});

describe('Club entry dialogs', () => {
  it.each([
    ['Create Club', createClub],
    ['Find Player', findPlayer],
    ['Join Club', joinClub],
  ])('%s is modal, labelled, and focus trapped', (_name, source) => {
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain('useFocusTrap(');
  });

  it('preserves the authoritative create service', () => {
    expect(createClub).toContain('ClubsService.create({');
  });

  it('preserves scoped player search and live table navigation', () => {
    expect(findPlayer).toContain('PlayerSearchService.search');
    expect(findPlayer).toContain('AbortController');
    expect(findPlayer).toContain('handleTableClick');
  });

  it('preserves shared code validation, referrals, and authoritative joining', () => {
    expect(joinService).toContain("from '../utils/clubCode'");
    expect(joinClub).toContain('ClubJoinService.parseInput');
    expect(joinClub).toContain('ClubJoinService.join');
  });
});

describe('Club Arena identity', () => {
  it('uses the replaceable live Club Arena brand and generated emblem', () => {
    expect(header).toContain('Club Arena by Smarter.Poker');
    expect(header).toContain('vault-iris-emblem-v1-320.webp');
    expect(header).toContain('className={styles.brandName}>Club Arena');
    expect(existsSync(resolve(root, 'public/images/club-arena/vault-iris-emblem-v1.png'))).toBe(
      true
    );
    expect(
      existsSync(resolve(root, 'public/images/club-arena/vault-iris-emblem-v1-320.webp'))
    ).toBe(true);
  });
});
