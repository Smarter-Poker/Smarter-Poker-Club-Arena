/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DAILY CLUB ARENA BONUS - the sheet
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-07: a reward sheet every player sees on entering Club Arena,
 * every day; diamonds, throwables, rabbit hunts and more; each tile claimed by
 * hand like the PokerBros bonus screen; premium, with depth, 3D metallic like
 * the lobby, never flat.
 *
 * Dan, 2026-09-08, on the first cut (CSS-drawn chrome, line icons): "THIS IS
 * NOT OK ... ALL THE BUTTONS, FRAMES, ICONS ETC NEED THE PREMIUM, HIGH DEF,
 * DYNAMIC LOOK AND FEEL AS THEY ARE INSIDE THE REST OF THE CLUB ARENA PAGES."
 * So the sheet is now cut from the approved shark console, the same art and
 * the same recipe as the selected-table panel under the game cards: chassis
 * rails that repeat to any height, the card's plaque for every readout, day
 * and reward, the console's own button faces, and the kit's painted renders
 * for icons (DailyBonusSheet.css lists each piece).
 *
 * Every figure on the sheet is the server's. The client decides which tile to
 * tap and nothing else (services/DailyBonusService.ts).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ClubIcon } from '../club-buttons/ClubButtons';
import { useToast } from '../common/Toast';
import { ThrowableImage } from '../table/ThrowableImage';
import { triggerHaptic } from '../../services/HapticService';
import { playPremiumSfx } from '../../utils/playPremiumSfx';
import { mediaUrl } from '../../utils/mediaBase';
import { diamondsToCentsLabel, type DailyBonusTile } from '../../services/DailyBonusService';
import { formatCountdown, useDailyBonus } from './useDailyBonus';
import './DailyBonusSheet.css';

export interface DailyBonusSheetProps {
  /** `modal` floats over the page with a backdrop; `inline` renders as a page section. */
  mode?: 'modal' | 'inline';
  onClose?: () => void;
  /** Modal only: the sheet is mounted while open. */
  open?: boolean;
}

const KIND_TITLE: Record<DailyBonusTile['kind'], string> = {
  diamonds: 'Diamonds',
  throwables: 'Throwables',
  rabbit_hunts: 'Rabbit Hunts',
  time_bank: 'Time Bank',
  mystery: 'Mystery Tile',
};

/** The painted renders already in the kit; the throwable is a 3D render from storage. */
const ICON_SRC = {
  diamonds: mediaUrl('images/diamond-icon.png'),
  vip: mediaUrl('images/global-header/vip.png'),
  rabbit_hunts: mediaUrl('game-card-icons/rabbit-hunt.png'),
  mystery: mediaUrl('game-card-icons/mystery-bounty.png'),
} as const;

/** The throwable tile shows the classic: the tomato render every table throws. */
const THROWABLE_ICON_ID = 'tomato';

function TileIcon({
  kind,
  vip,
  seconds,
}: {
  kind: DailyBonusTile['kind'];
  vip: boolean;
  seconds: number;
}) {
  if (kind === 'throwables') {
    return (
      <span className="dbs-tile__icon">
        <ThrowableImage throwableId={THROWABLE_ICON_ID} size={96} loading="lazy" />
      </span>
    );
  }
  if (kind === 'time_bank') {
    return (
      <span className="dbs-tile__icon dbs-tile__icon--seconds" aria-hidden="true">
        +{seconds}
        <small>Sec</small>
      </span>
    );
  }
  const src = kind === 'diamonds' ? (vip ? ICON_SRC.vip : ICON_SRC.diamonds) : ICON_SRC[kind];
  return (
    <span className="dbs-tile__icon">
      <img src={src} alt="" loading="lazy" decoding="async" draggable={false} />
    </span>
  );
}

function tileValue(tile: DailyBonusTile): { value: string; sub: string } {
  if (tile.kind === 'mystery') return { value: '?', sub: 'Tap To Reveal' };
  if (tile.kind === 'diamonds') {
    return { value: `+${tile.diamonds}`, sub: `${diamondsToCentsLabel(tile.diamonds)} Value` };
  }
  if (tile.kind === 'time_bank') {
    return { value: `×${tile.quantity}`, sub: '20 Seconds Each' };
  }
  return { value: `×${tile.quantity}`, sub: 'Yours For 7 Days' };
}

function grantedValue(tile: DailyBonusTile): string {
  const g = tile.granted;
  if (!g) return '';
  if (g.kind === 'diamonds') return `+${g.diamonds} Diamonds`;
  if (g.kind === 'time_bank') return `×${g.quantity} Time Bank`;
  return `×${g.quantity} ${KIND_TITLE[g.kind]}`;
}

interface TileProps {
  tile: DailyBonusTile;
  busy: boolean;
  disabled: boolean;
  onClaim: (tile: DailyBonusTile) => void;
  burst: boolean;
  revealed: boolean;
}

function BonusTile({ tile, busy, disabled, onClaim, burst, revealed }: TileProps) {
  const state = tile.claimed
    ? 'claimed'
    : tile.locked
      ? 'locked'
      : busy
        ? 'busy'
        : tile.capped
          ? 'capped'
          : 'ready';
  const { value, sub } = tileValue(tile);
  const granted = tile.claimed ? tile.granted : null;
  const iconKind: DailyBonusTile['kind'] = granted ? granted.kind : tile.kind;
  const seconds = (granted ? granted.quantity : tile.quantity) * 20;

  return (
    <article
      className="dbs-tile"
      data-kind={tile.kind}
      data-state={state}
      data-vip={tile.vip_only || undefined}
      data-burst={burst || undefined}
      data-revealed={revealed || undefined}
      aria-label={`${tile.label}, ${granted ? grantedValue(tile) : value}`}
    >
      <div className="dbs-plaque">
        <span className="dbs-plaque__label">{tile.label}</span>
        <span className="dbs-plaque__well">
          <TileIcon kind={iconKind} vip={tile.vip_only} seconds={seconds} />
          <span className="dbs-plaque__value">
            {granted
              ? granted.kind === 'diamonds'
                ? `+${granted.diamonds}`
                : `×${granted.quantity}`
              : value}
          </span>
          <span className="dbs-tile__sub">
            {granted
              ? granted.kind === 'diamonds'
                ? `${diamondsToCentsLabel(granted.diamonds)} Credited`
                : KIND_TITLE[granted.kind]
              : sub}
          </span>
        </span>
        {burst && (
          <span className="dbs-tile__sparks" aria-hidden="true">
            {Array.from({ length: 8 }, (_, i) => (
              <i key={i} style={{ '--i': i } as CSSProperties} />
            ))}
          </span>
        )}
      </div>
      {tile.claimed ? (
        <span className="dbs-btn dbs-btn--secondary">
          <ClubIcon name="spade" />
          Claimed
        </span>
      ) : tile.locked ? (
        <span className="dbs-btn dbs-btn--secondary dbs-btn--locked">VIP Members Only</span>
      ) : (
        <button
          type="button"
          className={`dbs-btn${busy ? ' dbs-btn--busy' : ''}`}
          onClick={() => onClaim(tile)}
          disabled={disabled || busy}
          aria-busy={busy || undefined}
        >
          {busy ? 'Claiming' : tile.capped ? 'Claim What Fits' : 'Claim'}
        </button>
      )}
      {tile.capped && !tile.claimed && (
        <span className="dbs-tile__note">Daily Cap Trims This One</span>
      )}
    </article>
  );
}

export default function DailyBonusSheet({
  mode = 'modal',
  onClose,
  open = true,
}: DailyBonusSheetProps) {
  const toast = useToast();
  const enabled = mode === 'inline' || open;
  const { status, loading, loadError, reload, claim, claimingSlot, secondsToReset } =
    useDailyBonus(enabled);
  const [burstSlot, setBurstSlot] = useState<number | null>(null);
  const [revealSlot, setRevealSlot] = useState<number | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const burstTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (burstTimer.current) clearTimeout(burstTimer.current);
    };
  }, []);

  // Modal chrome: lock scroll, focus the close control, Escape closes.
  useEffect(() => {
    if (mode !== 'modal' || !open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = sheetRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
      returnFocus?.focus();
    };
  }, [mode, open, onClose]);

  const handleClaim = useCallback(
    async (tile: DailyBonusTile) => {
      triggerHaptic('medium');
      const outcome = await claim(tile);
      if (!outcome) return;
      if (outcome.result.success && outcome.result.granted) {
        triggerHaptic('success');
        playPremiumSfx('ctaClick');
        setBurstSlot(tile.slot);
        if (tile.kind === 'mystery') setRevealSlot(tile.slot);
        if (burstTimer.current) clearTimeout(burstTimer.current);
        burstTimer.current = setTimeout(() => setBurstSlot(null), 1400);
        const g = outcome.result.granted;
        toast.success(
          g.kind === 'diamonds'
            ? `Claimed +${g.diamonds} Diamonds (${diamondsToCentsLabel(g.diamonds)})`
            : `Claimed ×${g.quantity} ${KIND_TITLE[g.kind]}`
        );
      } else {
        triggerHaptic('error');
        toast.error(outcome.refusal);
      }
    },
    [claim, toast]
  );

  if (mode === 'modal' && !open) return null;

  const body: ReactNode = (() => {
    if (loadError) {
      return (
        <div className="dbs__state" role="alert">
          <p>{loadError}</p>
          <button type="button" className="dbs-btn dbs-btn--wide" onClick={() => void reload()}>
            Try Again
          </button>
        </div>
      );
    }
    if (!status) {
      return (
        <div className="dbs__state" role="status" aria-live="polite">
          <span className="dbs__spinner" aria-hidden="true" />
          <p>Setting The Table</p>
        </div>
      );
    }
    if (!status.eligible) {
      return (
        <div className="dbs__state" role="status">
          <p>The Daily Bonus Is Not Available On This Account.</p>
        </div>
      );
    }
    const caps = status.caps;
    const tomorrow = status.tomorrow
      .filter((t) => !t.vip_only || status.is_vip)
      .map((t) =>
        t.kind === 'diamonds'
          ? `+${t.diamonds} Diamonds`
          : t.kind === 'mystery'
            ? 'A Mystery Tile'
            : `×${t.quantity} ${t.label}`
      )
      .join(' · ');
    return (
      <>
        <dl className="dbs__readouts">
          <div className="dbs-plaque" aria-label={`Day ${status.streak} Streak`}>
            <dt className="dbs-plaque__label">Streak</dt>
            <dd className="dbs-plaque__well">
              <span
                className={`dbs-plaque__value${status.claimed_today ? ' dbs-plaque__value--lit' : ''}`}
              >
                Day {status.streak}
              </span>
            </dd>
          </div>
          <div className="dbs-plaque">
            <dt className="dbs-plaque__label">Multiplier</dt>
            <dd className="dbs-plaque__well">
              <span className="dbs-plaque__value">×{status.multiplier.toFixed(1)}</span>
            </dd>
          </div>
          <div className="dbs-plaque">
            <dt className="dbs-plaque__label">Resets In</dt>
            <dd className="dbs-plaque__well">
              <span className="dbs-plaque__value dbs__clock">
                {formatCountdown(secondsToReset)}
              </span>
            </dd>
          </div>
        </dl>

        <ol className="dbs__week" aria-label="This Week">
          {status.week.map((d) => (
            <li key={d.day} className="dbs__day dbs-plaque" data-state={d.state}>
              <span className="dbs-plaque__label">Day {d.day}</span>
              <span className="dbs-plaque__well">
                <span className="dbs-plaque__value">
                  {d.diamonds != null ? `+${d.diamonds}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ol>

        <div className="dbs__tiles">
          {status.tiles.map((tile) => (
            <BonusTile
              key={tile.slot}
              tile={tile}
              busy={claimingSlot === tile.slot}
              disabled={claimingSlot !== null}
              onClaim={(t) => void handleClaim(t)}
              burst={burstSlot === tile.slot}
              revealed={revealSlot === tile.slot}
            />
          ))}
        </div>

        <footer className="dbs__foot">
          <p>
            <b>Streak</b>
            <span>
              {status.claimed_today
                ? 'Streak Locked In For Today.'
                : 'Claim At Least One Tile Today To Keep Your Streak.'}
            </span>
          </p>
          {tomorrow && (
            <p>
              <b>Tomorrow</b>
              <span>{tomorrow}</span>
            </p>
          )}
          {caps && (
            <p>
              <b>Daily Cap</b>
              <span>
                {caps.daily_used} / {caps.daily_cap} Diamonds Today
              </span>
            </p>
          )}
        </footer>
      </>
    );
  })();

  const sheet = (
    <section
      ref={sheetRef}
      className="dbs"
      data-mode={mode}
      role={mode === 'modal' ? 'dialog' : undefined}
      aria-modal={mode === 'modal' || undefined}
      aria-labelledby="dbs-title"
      aria-busy={loading || undefined}
    >
      <div className="dbs__panel">
        {mode === 'modal' && (
          <button
            ref={closeRef}
            type="button"
            className="dbs__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        )}
        <header className="dbs__head">
          <span className="dbs__eyebrow">Club Arena · Every Day You Show Up</span>
          <h2 id="dbs-title" className="dbs__title">
            Daily Club Arena Bonus
          </h2>
        </header>
        <div className="dbs__body">{body}</div>
      </div>
    </section>
  );

  if (mode === 'inline') return sheet;
  // Portaled to <body>: the hub home's container carries `perspective`, which
  // makes it the containing block for a fixed overlay rendered inside it, and
  // focusing the close control then scrolled that overflow-hidden container
  // and dragged the sheet off-screen (seen live 2026-09-08). Outside it, the
  // backdrop is the viewport.
  return createPortal(
    <div className="dbs-overlay" onClick={onClose}>
      <div className="dbs-overlay__center" onClick={(e) => e.stopPropagation()}>
        {sheet}
      </div>
    </div>,
    document.body
  );
}
