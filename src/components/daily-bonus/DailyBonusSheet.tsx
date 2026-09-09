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
 * Dan, 2026-09-09, on that cut: "FIX THE CLUB ARENA DAILY BONUS ... ITS SO
 * TRASH". The picture said why: a plaque inside every tile inside a grid,
 * three plaques across the top, seven more for the week, an icon in a well
 * inside a plaque inside a card. Frames on frames on frames - the one thing
 * he has ruled against since the first review.
 *
 * It is ONE picture now, the spade console (#ClubArenaConsole), and everything
 * prints on its glass: the three readouts as rows, the week as a single line
 * of lit numerals, each reward as a row with its own render beside the figure
 * and CLAIM as a lit word on that row. Nothing is boxed, nothing is nested,
 * and the only frame on the surface is the master's own.
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
import { SpadeConsole } from '../console/SpadeConsole';
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
        <ThrowableImage throwableId={THROWABLE_ICON_ID} size={64} loading="lazy" />
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
    /* A ROW, not a card. The render sits beside the figure with nothing drawn
       around it and CLAIM is a lit word on the same line, so a reward reads as
       one thing instead of a box inside a box inside a grid. */
    <li
      className="dbs-tile"
      data-kind={tile.kind}
      data-state={state}
      data-vip={tile.vip_only || undefined}
      data-burst={burst || undefined}
      data-revealed={revealed || undefined}
      aria-label={`${tile.label}, ${granted ? grantedValue(tile) : value}`}
    >
      <span className="dbs-plaque">
        <TileIcon kind={iconKind} vip={tile.vip_only} seconds={seconds} />
      </span>
      <span className="dbs-tile__lines">
        <span className="sc-label sc-ink--blue">{tile.label}</span>
        <span className="dbs-tile__sub">
          {granted
            ? granted.kind === 'diamonds'
              ? `${diamondsToCentsLabel(granted.diamonds)} Credited`
              : 'Added To Your Account'
            : sub}
        </span>
        {tile.capped && !tile.claimed && (
          <span className="dbs-tile__note sc-ink--gold">Daily Cap Trims This One</span>
        )}
      </span>
      <span className={`dbs-tile__value ${tile.vip_only ? 'sc-ink--gold' : 'sc-ink--silver'}`}>
        {granted
          ? granted.kind === 'diamonds'
            ? `+${granted.diamonds}`
            : `×${granted.quantity}`
          : value}
      </span>
      {tile.claimed ? (
        <span className="dbs-btn dbs-btn--secondary sc-ink--green">
          <ClubIcon name="spade" />
          Claimed
        </span>
      ) : tile.locked ? (
        <span className="dbs-btn dbs-btn--secondary dbs-btn--locked sc-ink--muted">
          VIP Members Only
        </span>
      ) : (
        <button
          type="button"
          className={`dbs-btn sc-ink--white${busy ? ' dbs-btn--busy' : ''}`}
          onClick={() => onClaim(tile)}
          disabled={disabled || busy}
          aria-busy={busy || undefined}
        >
          {busy ? 'Claiming' : tile.capped ? 'Claim What Fits' : 'Claim'}
        </button>
      )}
      {burst && (
        <span className="dbs-tile__sparks" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <i key={i} style={{ '--i': i } as CSSProperties} />
          ))}
        </span>
      )}
    </li>
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
            <dt className="dbs-plaque__label sc-label sc-ink--blue">Streak</dt>
            <dd
              className={`dbs-plaque__value${status.claimed_today ? ' sc-ink--green' : ' sc-ink--silver'}`}
            >
              Day {status.streak}
            </dd>
          </div>
          <div className="dbs-plaque">
            <dt className="dbs-plaque__label sc-label sc-ink--blue">Multiplier</dt>
            <dd className="dbs-plaque__value sc-ink--silver">×{status.multiplier.toFixed(1)}</dd>
          </div>
          <div className="dbs-plaque">
            <dt className="dbs-plaque__label sc-label sc-ink--blue">Resets In</dt>
            <dd className="dbs-plaque__value dbs__clock sc-ink--silver">
              {formatCountdown(secondsToReset)}
            </dd>
          </div>
        </dl>

        {/* The week is one line of lit numerals - the day you are on in white,
            the ones behind you in green, the ones ahead muted. Seven little
            boxes across a phone is exactly the shape Dan rejected. */}
        <ol className="dbs__week" aria-label="This Week">
          {status.week.map((d) => (
            <li key={d.day} className="dbs__day dbs-plaque" data-state={d.state}>
              <span className="dbs-plaque__label">{d.day}</span>
              <span className="dbs-plaque__value">
                {d.diamonds != null ? `+${d.diamonds}` : ''}
              </span>
            </li>
          ))}
        </ol>

        <ul className="dbs__tiles">
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
        </ul>

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
      <SpadeConsole
        as="div"
        className="dbs__panel"
        eyebrow="Every Day You Show Up"
        title="Daily Bonus"
        titleId="dbs-title"
        pill={status ? `Day ${status.streak}` : undefined}
        pillInk={status?.claimed_today ? 'green' : 'blue'}
        foot={mode === 'modal' ? 'plates' : 'foot'}
        plates={
          mode === 'modal'
            ? {
                secondary: {
                  label: 'Close',
                  buttonRef: closeRef,
                  onClick: onClose,
                  'aria-label': 'Close',
                },
                primary: {
                  label: 'Done',
                  ink: 'white',
                  onClick: onClose,
                },
              }
            : undefined
        }
      >
        {body}
      </SpadeConsole>
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
