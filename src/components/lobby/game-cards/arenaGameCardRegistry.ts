import type { ArenaGameCardTemplate, ArenaGameFamily } from './arenaGameCardTypes';

const asset = (path: string) => `${import.meta.env.BASE_URL}assets/club-buttons/game-cards/${path}`;

export const ARENA_GAME_CARD_TEMPLATES: Record<ArenaGameFamily, ArenaGameCardTemplate> = {
  mtt: {
    family: 'mtt',
    desktopArtwork: asset('mtt/desktop.png'),
    mobileArtwork: asset('mtt/mobile.png'),
    desktopAspectRatio: '754 / 944',
    mobileAspectRatio: '754 / 944',
    zones: ['title', 'meta', 'badges', 'facts', 'progress', 'actions'],
  },
  nlh: {
    family: 'nlh',
    desktopArtwork: asset('nlh/desktop.png'),
    mobileArtwork: asset('nlh/mobile.png'),
    desktopAspectRatio: '722 / 930',
    mobileAspectRatio: '754 / 823',
    zones: ['title', 'status', 'game', 'stakes', 'players', 'buy-in', 'actions'],
  },
  plo: {
    family: 'plo',
    desktopArtwork: asset('plo/desktop.png'),
    mobileArtwork: asset('plo/mobile.png'),
    desktopAspectRatio: '706 / 856',
    mobileAspectRatio: '754 / 944',
    zones: ['title', 'status', 'identity', 'facts', 'rules', 'actions'],
  },
  spin: {
    family: 'spin',
    desktopArtwork: asset('spins/desktop.png'),
    mobileArtwork: asset('spins/mobile.png'),
    desktopAspectRatio: '754 / 944',
    mobileAspectRatio: '754 / 944',
    zones: ['title', 'promotion', 'max-payout', 'facts', 'actions'],
  },
  'heads-up': {
    family: 'heads-up',
    desktopArtwork: asset('heads-up/desktop.png'),
    mobileArtwork: asset('heads-up/mobile.png'),
    desktopAspectRatio: '754 / 944',
    mobileAspectRatio: '754 / 944',
    zones: ['title', 'status', 'game', 'facts', 'format', 'actions'],
  },
};

export function resolveArenaGameCardTemplate(family: ArenaGameFamily) {
  return ARENA_GAME_CARD_TEMPLATES[family];
}
