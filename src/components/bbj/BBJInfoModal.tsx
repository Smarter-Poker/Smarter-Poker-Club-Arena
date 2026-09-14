/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BBJ INFO MODAL — opened by tapping the jackpot, in the lobby or at the table
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan (2026-08-20): tapping the BBJ anywhere should open one popup with three
 * pages — the total and the last 5 winners first, then the fee schedule and
 * payouts by stakes, then the qualifying hands. And inside the winners page you
 * should be able to tap any winner and see a rundown of the hand.
 *
 * Tabs, in that order:
 *   Winner           the pool total in the header, then the last 5 hits.
 *                    Tapping a hit swaps the body for BBJHandDetail.
 *   Basic            what the hand is charged and how a hit splits, per stake.
 *   Qualifying Hands the minimum losing hand for every game we spread, as cards.
 *
 * When opened from a table, that table's game and stakes rows are marked
 * "YOUR GAME" / "YOUR STAKES" and a summary of what a hit would pay right here
 * sits at the top of Basic. Opened from the lobby (no table context) the same
 * tabs show the full tables without the highlight.
 *
 * THE MINI (Dan 2026-09-11): "INSIDE THE BBJ POP UP, YOU NEED TO SEPERATE BBJ
 * WINERS, AND MINI BBJ WINNERS. THERE SHOULD BE A CLICKABLE TAB FOR THE MINI
 * (SHOULDN'T BE A MAIN FEATURE). SAME THING WITH THE BASIC AND THE QUALIFYING
 * HANDS PAGES." So the three main tabs stay exactly as they were, and under
 * them sits a small second row - Bad Beat Jackpot | Mini - that swaps each
 * page to the mini's own winners, schedule and qualifying hands. The header
 * follows it: the main pool, or the flat mini for this table's stakes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import BBJRecentHits from './BBJRecentHits';
import BBJBasicPanel from './BBJBasicPanel';
import BBJQualifyingHands from './BBJQualifyingHands';
import BBJHandDetail from './BBJHandDetail';
import {
  getBBJQualifyingInfo,
  getBBJPayoutPercentForBB,
  normalizeVariantKey,
} from '../../config/RakeConfig';
import {
  getBBJMiniQualifyingInfo,
  BBJ_MINI_SPLIT,
  BBJ_MINI_SPLIT_PERCENT,
  BBJ_MINI_PAUSE_TEXT,
  miniPauseReason,
} from '../../config/bbjMini';
import { miniTierForBB, type BbjMiniSnapshot } from '../../lib/bbjMiniFeed';
import { SpadeConsole } from '../console/SpadeConsole';
import './BBJInfoModal.css';

export interface BBJInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  poolId: string | null;
  poolAmount: number;
  /** Table's game variant (key or display name). Omit when opened from a lobby. */
  gameType?: string | null;
  /** Table's big blind, for the "what this table pays" figure. Omit in a lobby. */
  bigBlind?: number;
  currentUserName?: string | null;
  /**
   * The viewer's own user id. Preferred over the name for "this is you"
   * highlighting: display names are not unique, and two players called "Dan" at
   * the same table would both light up. The name stays as a fallback for
   * surfaces that only know it.
   */
  currentUserId?: string | null;
  /**
   * The mini jackpot for this club (lib/bbjMiniFeed). Null until the feed has
   * answered; the Mini row still renders and says it is reading.
   */
  mini?: BbjMiniSnapshot | null;
}

type Tab = 'winner' | 'basic' | 'qualifying';
/** The second row: which jackpot the current page is about. */
type Tier = 'main' | 'mini';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'winner', label: 'Winner' },
  { key: 'basic', label: 'Basic' },
  { key: 'qualifying', label: 'Qualifying Hands' },
];

export function BBJInfoModal({
  isOpen,
  onClose,
  poolId,
  poolAmount,
  gameType,
  bigBlind = 0,
  currentUserName,
  currentUserId,
  mini = null,
}: BBJInfoModalProps) {
  const [tab, setTab] = useState<Tab>('winner');
  const [tier, setTier] = useState<Tier>('main');
  /** Non-null while the winners tab is drilled into one hand. */
  const [openHandPayoutId, setOpenHandPayoutId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  /**
   * Focus management. Without it, opening this over the lobby leaves focus on
   * the wallet behind the backdrop: a keyboard or screen-reader user tabs
   * straight through the page underneath and never reaches the dialog they just
   * opened. Focus moves in on open, is held inside while open, and is handed
   * back to whatever opened it on close.
   */
  useEffect(() => {
    if (!isOpen) return;
    restoreFocusRef.current = (document.activeElement as HTMLElement) || null;
    const node = dialogRef.current;
    if (node) {
      const first = node.querySelector<HTMLElement>(
        'button, [href], [tabindex]:not([tabindex="-1"])'
      );
      (first || node).focus({ preventScroll: true });
    }
    return () => {
      const back = restoreFocusRef.current;
      if (back && typeof back.focus === 'function' && document.contains(back)) {
        back.focus({ preventScroll: true });
      }
    };
  }, [isOpen]);

  const onDialogKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const node = dialogRef.current;
    if (!node) return;
    const focusable = Array.from(
      node.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  // Escape closes the drilldown first, then the modal — otherwise a player deep
  // in a hand loses the whole popup on one keypress. Body scroll locked while
  // open.
  /**
   * The Escape behaviour, held in a ref.
   *
   * The effect below writes body styles and measures the scrollbar, and it
   * used to depend on `onClose` and `openHandPayoutId`. `onClose` is an inline
   * arrow at both call sites, so its identity changed on every parent render —
   * at a live table that is every engine tick, each one tearing down a window
   * listener and forcing a layout. Keeping the behaviour current in a ref lets
   * the effect depend only on whether the popup is open.
   */
  const escapeRef = useRef<() => void>(() => {});
  escapeRef.current = () => {
    if (openHandPayoutId) setOpenHandPayoutId(null);
    else onClose();
  };

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      escapeRef.current();
    };
    window.addEventListener('keydown', onKey);

    /* THE SCROLLBAR IS PART OF THE LAYOUT (2026-08-21).
     *
     * Locking body overflow removes the scrollbar, and on a desktop browser
     * that hands ~15px of width back to the page. Everything underneath
     * re-lays-out sideways the instant the popup opens, and jumps back when it
     * closes - which reads as the whole page glitching, because it is. Holding
     * the width with padding keeps the page still. */
    const prevOverflow = document.body.style.overflow;
    const prevPadding = document.body.style.paddingRight;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (gap > 0) {
      const current = parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
      document.body.style.paddingRight = `${current + gap}px`;
    }
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPadding;
    };
    // `onClose` is an inline arrow at both call sites (TableModalsLayer and
    // ClubHomePage), so its identity changes on every parent render. Depending
    // on it tore down and re-added a window listener, rewrote body styles and
    // re-measured the scrollbar - a forced layout - on every engine tick while
    // the popup was open at a live table. The handler is held in a ref so the
    // effect depends only on whether the popup is open.
  }, [isOpen]);

  // A reopened popup starts on the winners list, never inside the last hand
  // someone happened to look at.
  useEffect(() => {
    if (!isOpen) {
      setTab('winner');
      setTier('main');
      setOpenHandPayoutId(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // A lobby opens this with no table context — then we show the full tables
  // only, with nothing marked "yours", instead of inventing a stake.
  const hasTableContext = !!gameType && bigBlind > 0;
  const info = getBBJQualifyingInfo(gameType);
  const pct = getBBJPayoutPercentForBB(bigBlind);
  const tableShare = (poolAmount * pct) / 100;

  /* THE MINI FOR THESE STAKES. The tier is chosen by big blind exactly as the
     payout RPC chooses it; a tier that cannot pay right now is shown as paused
     rather than as a number. In the lobby there is no stake, so the header
     shows the range the mini pays across the club's tiers. */
  const miniInfo = getBBJMiniQualifyingInfo(gameType);
  const miniTier = hasTableContext && mini ? miniTierForBB(mini, bigBlind) : null;
  /* A SHOWN MINI IS A PAYABLE MINI. This filtered on `enabled` alone, so the
     lobby header - which has no stake and falls through to the range - printed
     "250 - 1,500" while every tier was paused at the reserve floor, or while
     the club had switched the mini off entirely. `payable` is the database's
     own answer to "would the payout RPC accept this", and it is the only thing
     any surface may range over. Same filter as the lobby tile, the jackpot
     page and the settings panel. */
  const miniPayableTiers = mini ? mini.tiers.filter((t) => t.enabled && t.payable) : [];
  const miniAmounts = miniPayableTiers.map((t) => t.amount);
  const miniRange =
    miniAmounts.length > 0
      ? {
          lo: Math.min(...miniAmounts),
          hi: Math.max(...miniAmounts),
        }
      : null;
  /* WHY it is not paying, unfolded once from the snapshot (config/bbjMini).
     Without this the popup read "Reserve At Its Floor" for a club that had
     simply switched the mini off - the wrong reason, printed directly under a
     header already reading "Off". */
  const miniPause = miniPauseReason(mini, miniTier);
  const isMini = tier === 'mini';

  const switchTab = (next: Tab) => {
    setOpenHandPayoutId(null);
    setTab(next);
  };
  const switchTier = (next: Tier) => {
    setOpenHandPayoutId(null);
    setTier(next);
  };

  // Left/right move between tabs, Home/End jump to the ends - the ARIA tabs
  // pattern. Without it a keyboard user has to Tab through a whole panel to
  // reach the next tab.
  const onTabsKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.key === tab);
    if (i < 0) return;
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    else return;
    e.preventDefault();
    switchTab(TABS[next].key);
  };

  /* THE HEADER FOLLOWS THE ROW: the main pool, or the flat mini for this
     table's stakes. Printed as the console's title, whole chips, never
     overstated (Math.trunc) and never a decimal on a forward-facing page. */
  const headline = isMini
    ? !mini
      ? 'Reading'
      : !mini.enabled
        ? 'Off'
        : miniTier
          ? miniTier.payable
            ? Math.trunc(miniTier.amount).toLocaleString('en-US')
            : 'Paused'
          : miniRange
            ? miniRange.lo === miniRange.hi
              ? Math.trunc(miniRange.lo).toLocaleString('en-US')
              : `${Math.trunc(miniRange.lo).toLocaleString('en-US')} - ${Math.trunc(miniRange.hi).toLocaleString('en-US')}`
            : /* "Off" is only true when the switch is off. A club whose
                 reserve is at its floor is PAUSED, and the subtitle says so -
                 the same words the jackpot page uses. */
              miniPause === 'reserve_at_floor'
              ? 'Paused'
              : 'Off'
    : Math.trunc(Number(poolAmount || 0)).toLocaleString('en-US');
  const sublabel =
    isMini && (miniTier || miniPause)
      ? miniPause
        ? BBJ_MINI_PAUSE_TEXT[miniPause]
        : `Flat, At ${miniTier?.label} Stakes`
      : undefined;

  /* PORTALLED TO THE BODY, like every other overlay here (Modal, Dropdown,
   * AdvancedFilters, TournamentRankingCard). This was the only one rendered
   * inline in the page tree, which means a single `transform`, `filter` or
   * `contain` on any ancestor turns it into that ancestor's containing block -
   * and a "fixed" backdrop that is really positioned against a card in the
   * lobby is exactly the kind of thing that looks like the page tearing.
   *
   * ONE CONSOLE (#ClubArenaConsole): the spade master. The pool is the
   * engraved title, the tier the word in the painted pill slot, the stakes
   * line the subtitle; the three pages and the Bad Beat Jackpot | Mini pair
   * are lit words on the glass, and CLOSE is the lit word at the foot. The
   * `bbj-modal__amount--mini` modifier on the dialog is what makes a flat
   * mini read as a smaller figure than the pool. */
  return createPortal(
    <div className="bbj-modal__backdrop" onClick={onClose} role="presentation">
      <div
        className={isMini ? 'bbjc bbj-modal__amount--mini' : 'bbjc'}
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="Bad Beat Jackpot"
      >
        <SpadeConsole
          eyebrow={isMini ? 'MINI BAD BEAT JACKPOT' : 'BAD BEAT JACKPOT'}
          title={headline}
          subtitle={sublabel}
          pill={isMini ? 'Mini' : 'Main'}
          pillInk={isMini ? 'gold' : 'blue'}
          foot="foot"
          className="bbjc__console"
        >
          <div
            className="bbj-modal__tabs"
            role="tablist"
            aria-label="Bad Beat Jackpot Sections"
            onKeyDown={onTabsKeyDown}
          >
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                id={`bbj-tab-${t.key}`}
                aria-selected={tab === t.key}
                aria-controls="bbj-tabpanel"
                tabIndex={tab === t.key ? 0 : -1}
                className={`bbj-modal__tab${tab === t.key ? ' is-active' : ''}`}
                onClick={() => switchTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* THE SECOND ROW - not a fourth tab. Dan: "a clickable tab for the
              mini (shouldn't be a main feature)". It sits under the three pages
              and swaps the page in place, so Winner / Basic / Qualifying keep
              their meaning and the mini is one tap away on each. */}
          <div className="bbj-modal__tiers" role="group" aria-label="Which Jackpot">
            <button
              type="button"
              className={`bbj-modal__tier${!isMini ? ' is-active' : ''}`}
              aria-pressed={!isMini}
              onClick={() => switchTier('main')}
            >
              Bad Beat Jackpot
            </button>
            <button
              type="button"
              className={`bbj-modal__tier${isMini ? ' is-active' : ''}`}
              aria-pressed={isMini}
              onClick={() => switchTier('mini')}
            >
              Mini
            </button>
          </div>

          <div
            className="bbj-modal__body"
            id="bbj-tabpanel"
            role="tabpanel"
            aria-labelledby={`bbj-tab-${tab}`}
            tabIndex={0}
          >
            {tab === 'winner' &&
              (openHandPayoutId ? (
                <BBJHandDetail
                  payoutId={openHandPayoutId}
                  onBack={() => setOpenHandPayoutId(null)}
                  currentUserName={currentUserName}
                  currentUserId={currentUserId}
                />
              ) : (
                <BBJRecentHits
                  key={tier}
                  poolId={poolId}
                  limit={5}
                  currentUserName={currentUserName}
                  currentUserId={currentUserId}
                  onOpenHand={setOpenHandPayoutId}
                  poolAmount={poolAmount}
                  kind={tier}
                />
              ))}

            {tab === 'basic' && isMini && (
              <div className="bbj-modal__rules">
                {hasTableContext && miniInfo.eligible && miniTier && (
                  <div className="bbj-modal__here">
                    <span className="bbj-modal__rule-label">If It Hits At This Table</span>
                    <p className="bbj-modal__rule-text">
                      {miniPause ? (
                        <>
                          Paused At {miniTier.label} Stakes - {BBJ_MINI_PAUSE_TEXT[miniPause]}
                        </>
                      ) : (
                        <>
                          <strong>{Math.trunc(miniTier.amount).toLocaleString('en-US')}</strong>{' '}
                          Flat ({miniTier.label} Stakes)
                        </>
                      )}
                    </p>
                    {!miniPause && (
                      <div className="bbj-modal__split">
                        <div className="bbj-modal__split-row">
                          <span>Bad Beat Hand</span>
                          <span>
                            {BBJ_MINI_SPLIT_PERCENT.loser} &middot;{' '}
                            {Math.trunc(miniTier.amount * BBJ_MINI_SPLIT.loser).toLocaleString(
                              'en-US'
                            )}
                          </span>
                        </div>
                        <div className="bbj-modal__split-row">
                          <span>Won The Hand</span>
                          <span>
                            {BBJ_MINI_SPLIT_PERCENT.winner} &middot;{' '}
                            {Math.trunc(miniTier.amount * BBJ_MINI_SPLIT.winner).toLocaleString(
                              'en-US'
                            )}
                          </span>
                        </div>
                        <div className="bbj-modal__split-row">
                          <span>Everyone Else Dealt In</span>
                          <span>
                            {BBJ_MINI_SPLIT_PERCENT.table} &middot;{' '}
                            {Math.trunc(miniTier.amount * BBJ_MINI_SPLIT.table).toLocaleString(
                              'en-US'
                            )}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {hasTableContext && !miniInfo.eligible && (
                  <div className="bbj-modal__here">
                    <p className="bbj-modal__rule-text">
                      The Mini Bad Beat Jackpot Is Not Available For {miniInfo.variantLabel}.
                    </p>
                  </div>
                )}
                <BBJBasicPanel kind="mini" mini={mini} highlightBB={bigBlind} />
                <p className="bbj-modal__fineprint">
                  Chips Are Credited To Your Stack At The Table The Moment It Hits, And They Leave
                  With You.
                </p>
              </div>
            )}

            {tab === 'basic' && !isMini && (
              <div className="bbj-modal__rules">
                {hasTableContext && info.eligible && (
                  <div className="bbj-modal__here">
                    <span className="bbj-modal__rule-label">If It Hits At This Table</span>
                    <p className="bbj-modal__rule-text">
                      <strong>{pct}%</strong> Of The Pool
                      {poolAmount > 0 && (
                        <> (About {Math.trunc(tableShare).toLocaleString('en-US')} Today)</>
                      )}
                    </p>
                    <div className="bbj-modal__split">
                      <div className="bbj-modal__split-row">
                        <span>Bad Beat Hand</span>
                        <span>
                          50% &middot; {Math.trunc(tableShare * 0.5).toLocaleString('en-US')}
                        </span>
                      </div>
                      <div className="bbj-modal__split-row">
                        <span>Won The Hand</span>
                        <span>
                          25% &middot; {Math.trunc(tableShare * 0.25).toLocaleString('en-US')}
                        </span>
                      </div>
                      <div className="bbj-modal__split-row">
                        <span>Everyone Else Dealt In</span>
                        <span>
                          25% &middot; {Math.trunc(tableShare * 0.25).toLocaleString('en-US')}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
                {hasTableContext && !info.eligible && (
                  <div className="bbj-modal__here">
                    <p className="bbj-modal__rule-text">
                      The Bad Beat Jackpot Is Not Available For {info.variantLabel}, So No Fee Is
                      Taken At This Table.
                    </p>
                  </div>
                )}
                <BBJBasicPanel poolAmount={poolAmount} highlightBB={bigBlind} />
                <p className="bbj-modal__fineprint">
                  Chips Are Credited To Your Stack At The Table The Moment It Hits, And They Leave
                  With You.
                </p>
              </div>
            )}

            {tab === 'qualifying' && (
              <div className="bbj-modal__rules">
                {hasTableContext && (
                  <div className="bbj-modal__here">
                    {(isMini ? miniInfo.eligible : info.eligible) ? (
                      <>
                        <span className="bbj-modal__rule-label">At This Table</span>
                        <p className="bbj-modal__rule-text">
                          {isMini ? miniInfo.shortLabel : info.shortLabel}
                        </p>
                        {(isMini ? miniInfo.subLabel : info.subLabel) && (
                          <p className="bbj-modal__rule-sub">
                            {isMini ? miniInfo.subLabel : info.subLabel}
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="bbj-modal__rule-text">
                        The {isMini ? 'Mini ' : ''}Bad Beat Jackpot Is Not Available For{' '}
                        {info.variantLabel}.
                      </p>
                    )}
                  </div>
                )}
                <BBJQualifyingHands
                  kind={tier}
                  highlightVariantKey={gameType ? normalizeVariantKey(gameType) : null}
                />
              </div>
            )}
          </div>

          <div className="bbjc__actions">
            <button
              type="button"
              className="bbjc-word sc-ink--white"
              onClick={onClose}
              aria-label="Close"
            >
              Close
            </button>
          </div>
        </SpadeConsole>
      </div>
    </div>,
    document.body
  );
}

export default BBJInfoModal;
