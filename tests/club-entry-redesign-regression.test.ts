import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBetween, sliceCssRule } from './helpers/sourceWindow';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const home = read('src/pages/HomePage.tsx');
const actionBar = read('src/components/home/ClubEntryActionBar.tsx');
const createClub = read('src/components/modals/CreateClubModal.tsx');
const findPlayer = read('src/components/modals/FindPlayerModal.tsx');
const joinClub = read('src/components/modals/JoinClubModal.tsx');
const joinService = read('src/services/ClubJoinService.ts');
const header = read('src/components/navigation/GlobalHeader.tsx');
const homeCss = read('src/pages/HomePage.module.css');
const createCss = read('src/components/modals/CreateClubModal.module.css');
const findCss = read('src/components/modals/FindPlayerModal.module.css');
const joinCss = read('src/components/modals/JoinClubModal.module.css');
const emptyStateCss = read('src/components/common/EmptyState.module.css');

describe('Club Arena primary actions', () => {
  it('uses the approved action artwork with semantic controls', () => {
    expect(actionBar).toContain('aria-label="Poker Arena Actions"');
    expect(actionBar).toContain('aria-label="Create A Club"');
    expect(actionBar).toContain('aria-label="Find A Player"');
    expect(actionBar).toContain('aria-label="Join A Club"');
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

  it('scales the complete approved artwork without cropping its frame or corners', () => {
    expect(sliceCssRule(homeCss, '.actionBarArtwork')).toMatch(/object-fit:\s*contain/);
    expect(sliceCssRule(homeCss, '.actionBarWrapper')).not.toMatch(/overflow:\s*hidden/);
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

  it('keeps Create Club full-page with an independently scrolling console body and painted foot', () => {
    // The scroll body is printed INSIDE the console, so it is the console's own
    // body; the plates are the console's painted foot, outside it.
    const consoleJsx = sliceBetween(createClub, '<SpadeConsole', '</SpadeConsole>');
    expect(consoleJsx).toContain('className={styles.scrollBody}');
    expect(consoleJsx).toContain('plates={{');
    expect(createCss).toMatch(/height:\s*100dvh/);
    expect(sliceCssRule(createCss, '.console > :global(.sc__body)')).toMatch(/min-height:\s*0/);
    expect(sliceCssRule(createCss, '.scrollBody')).toMatch(/overflow-y:\s*auto/);
  });

  it.each([
    ['Create Club', createClub, createCss],
    ['Find Player', findPlayer, findCss],
    ['Join Club', joinClub, joinCss],
  ])(
    '%s is a full page with an independently scrolling body and locked footer',
    (_name, source, css) => {
      expect(source).toContain('className={styles.scrollBody}');
      expect(source).toContain('className={styles.pageFooter}');
      expect(css).toMatch(/height:\s*100dvh/);
      expect(sliceCssRule(css, '.scrollBody')).toMatch(/overflow-y:\s*auto/);
      expect(sliceCssRule(css, '.pageFooter')).toMatch(/flex:\s*0 0 auto/);
      expect(sliceCssRule(css, '.pageFooter')).toMatch(/safe-area-inset-bottom/);
    }
  );

  it('keeps shared empty and permission panels inside a short landscape viewport', () => {
    expect(emptyStateCss).toMatch(/@media \(max-height:\s*560px\)/);
    expect(emptyStateCss).toMatch(/max-height:\s*calc\(100dvh - 96px\)/);
    expect(emptyStateCss).toMatch(/overflow-y:\s*auto/);
  });
});

describe('global Smarter.Poker identity', () => {
  it('never covers the approved global wordmark with a Club Arena plate', () => {
    expect(header).toContain('Smarter.Poker Global Header');
    expect(header).not.toContain('Club Arena by Smarter.Poker');
    expect(header).not.toContain('vault-iris-emblem-v1-320.webp');
    expect(header).not.toContain('className={styles.brandName}>Club Arena');
    expect(existsSync(resolve(root, 'public/images/club-arena/vault-iris-emblem-v1.png'))).toBe(
      true
    );
    expect(
      existsSync(resolve(root, 'public/images/club-arena/vault-iris-emblem-v1-320.webp'))
    ).toBe(true);
  });
});
