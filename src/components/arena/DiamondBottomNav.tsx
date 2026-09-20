/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DIAMOND ARENA FOOTER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-11: "DIAMOND ARENA NEEDS TO BE A 1:1 CLONE OF THE CLUB ARENA.
 * (ONLY DIFFERENCE IS ITS ALL 'ONE OPEN CLUB' WITH NO UNIONS OR AGENTS AND ITS
 * PLAYED WITH DIAMONDS INSTEAD OF CHIPS)".
 *
 * The chip footer is kept off the arena on purpose: its cells are chip doors
 * (the wheel, the chip cashier, Club Data, the Market) and its artwork names
 * them. Until this bar existed nothing stood in its place, so a Diamond player
 * in the lobby had no way to Players, Hand History, Stats, Messages or their
 * wallet. This is the same chassis (`ClubBottomNav.module.css`: fixed to the
 * bottom edge, the frame's own aspect ratio, the overscan, hide on scroll,
 * the published bottom-chrome height) carrying exactly the six player doors:
 *
 *   Lobby          the arena's shared lobby
 *   Hand History   the player's own record, scoped to the arena (?arena=diamond)
 *   Stats          the player's stats, scoped to the arena (?club=diamond-arena)
 *   Players        the arena roster
 *   Messages       the messenger, scoped to the arena
 *   Wallet         the Diamond wallet, opened in place (DiamondWalletModal)
 *
 * No agents, no union, no finance, no operations: the list here and the
 * allowlist in `diamondArenaRoutes.ts` are the same list, and
 * tests/unit/clubFooterRouteAudit.test.ts holds them together.
 *
 * The frame is the chip master with its painted doors removed by surgery
 * (see the stylesheet); the words are printed, fitted and centred in six
 * equal cells. Nothing is drawn.
 */
import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { DIAMOND_ARENA_SLUG } from '../../lib/constants';
import { withClubContext } from '../../utils/clubScopedPath';
import { useFitText } from '../lobby/game-cards/useFitText';
import { usePublishBottomChromeHeight } from '../club/ClubBottomNav';
import {
  DIAMOND_HAND_HISTORY_PARAM,
  DIAMOND_HAND_HISTORY_VALUE,
} from '../club/clubFooterVisibility';
import { useHideFooterOnScroll } from '../club/useHideFooterOnScroll';
import { isDiamondArenaLobbyPath, isDiamondArenaPlayerPath } from './diamondArenaRoutes';
import chassis from '../club/ClubBottomNav.module.css';
import styles from './DiamondBottomNav.module.css';

const DiamondWalletModal = lazy(() => import('../wallet/DiamondWalletModal'));
const DiamondTopUpModal = lazy(() =>
  import('../vip/DiamondTopUpModal').then((module) => ({ default: module.DiamondTopUpModal }))
);

export type DiamondTabKey = 'lobby' | 'hand-history' | 'stats' | 'players' | 'messages' | 'wallet';

interface DiamondDoor {
  key: DiamondTabKey;
  label: string;
  /** A route, or null for the wallet, which opens in place. */
  to: string | null;
}

/** The derived frame: the chip master's chrome with the painted doors removed. */
const DIAMOND_FOOTER_ART = `${import.meta.env.BASE_URL}images/club-footer/diamond-arena-footer-v1.webp`;

const ARENA_ROOT = `/clubs/${DIAMOND_ARENA_SLUG}`;

/** The six doors, in order. Exported so the route audit can hold the list. */
export const DIAMOND_FOOTER_DOORS: readonly DiamondDoor[] = Object.freeze([
  { key: 'lobby', label: 'Lobby', to: ARENA_ROOT },
  {
    key: 'hand-history',
    label: 'Hand History',
    to: `/hand-history?${DIAMOND_HAND_HISTORY_PARAM}=${DIAMOND_HAND_HISTORY_VALUE}`,
  },
  { key: 'stats', label: 'Stats', to: withClubContext('/stats', DIAMOND_ARENA_SLUG) },
  { key: 'players', label: 'Players', to: `${ARENA_ROOT}/members` },
  { key: 'messages', label: 'Messages', to: `${ARENA_ROOT}/messages` },
  { key: 'wallet', label: 'Wallet', to: null },
]);

/** The door representing the page currently open, or null for anything else. */
export function activeDiamondTabForPath(pathname: string): DiamondTabKey | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (isDiamondArenaLobbyPath(path)) return 'lobby';
  if (path === '/hand-history') return 'hand-history';
  if (path === '/stats' || path.startsWith('/stats/')) return 'stats';
  if (!isDiamondArenaPlayerPath(path)) return null;
  const segment = path.split('/').filter(Boolean)[2];
  if (segment === 'members') return 'players';
  if (segment === 'messages') return 'messages';
  return null;
}

/** One fitted word, centred in its cell's face. */
function DoorLabel({ text }: { text: string }) {
  const ref = useFitText<HTMLSpanElement>(text, 1, 0.6);
  return (
    <span ref={ref} className={styles.label} aria-hidden="true">
      {text}
    </span>
  );
}

export default function DiamondBottomNav() {
  const location = useLocation();
  const activeTab = useMemo(() => activeDiamondTabForPath(location.pathname), [location.pathname]);
  const { hidden, reveal } = useHideFooterOnScroll(location.pathname);
  const navRef = useRef<HTMLElement | null>(null);
  usePublishBottomChromeHeight(navRef, hidden);
  /* The wallet opens over whatever page the player is on and never
     navigates, exactly as DiamondArenaWallet opens it over the lobby. */
  const [wallet, setWallet] = useState<'closed' | 'wallet' | 'top-up'>('closed');

  return (
    <>
      <nav
        ref={navRef}
        className={chassis.bottomNav}
        aria-label="Diamond Arena"
        data-footer-hidden={hidden ? 'true' : 'false'}
        data-arena-footer="diamond"
        onFocusCapture={reveal}
        style={{ transform: hidden ? 'translateY(100%)' : 'none' }}
      >
        <div className={chassis.viewport}>
          <div className={`${chassis.artwork} ${styles.frame}`}>
            <img
              className={chassis.artworkImage}
              src={DIAMOND_FOOTER_ART}
              alt=""
              width="1916"
              height="256"
              decoding="async"
              draggable={false}
            />
            <ul className={styles.navItems}>
              {DIAMOND_FOOTER_DOORS.map((door) => (
                <li key={door.key} className={styles.navCell}>
                  {door.to === null ? (
                    <button
                      type="button"
                      className={styles.navItem}
                      aria-label={door.label}
                      aria-haspopup="dialog"
                      aria-expanded={wallet !== 'closed'}
                      data-footer-control={door.key}
                      onClick={() => setWallet('wallet')}
                    >
                      <span className={chassis.visuallyHidden}>{door.label}</span>
                      <DoorLabel text={door.label} />
                    </button>
                  ) : (
                    <Link
                      className={styles.navItem}
                      to={door.to}
                      aria-label={door.label}
                      aria-current={activeTab === door.key ? 'page' : undefined}
                      data-footer-control={door.key}
                    >
                      <span className={chassis.visuallyHidden}>{door.label}</span>
                      <DoorLabel text={door.label} />
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </nav>
      <Suspense fallback={null}>
        {wallet === 'wallet' && (
          <DiamondWalletModal
            isOpen
            onClose={() => setWallet('closed')}
            onBuyClick={() => setWallet('top-up')}
          />
        )}
        {wallet === 'top-up' && <DiamondTopUpModal isOpen onClose={() => setWallet('wallet')} />}
      </Suspense>
    </>
  );
}
