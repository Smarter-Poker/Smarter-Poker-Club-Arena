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
 * Built on the painted shell kit: each tile sits in the club-utility shell
 * (brushed steel, black bay, crystal side lights) and the chassis follows the
 * chamfered chrome of `.cb-modal`. Blue, white, black; diamonds read cyan;
 * brass is reserved for the VIP tile (yellow is outside the schema).
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
import { ClubIcon } from '../club-buttons/ClubButtons';
import { useToast } from '../common/Toast';
import { triggerHaptic } from '../../services/HapticService';
import { playPremiumSfx } from '../../utils/playPremiumSfx';
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

function TileIcon({ kind }: { kind: DailyBonusTile['kind'] }) {
  if (kind === 'diamonds') return <ClubIcon name="diamond" />;
  if (kind === 'rabbit_hunts') return <ClubIcon name="rabbit" />;
  if (kind === 'time_bank') return <ClubIcon name="timer" />;
  if (kind === 'throwables') {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        aria-hidden="true"
      >
        <path
          d="M12 3l1.6 3.9L18 6.2l-2.6 3.2L17.5 14l-3.9-1.3L11 16l-.2-4.3L7 9.9l3.8-1.6z"
          strokeLinejoin="round"
        />
        <path d="M5 19l3-3M19 19l-3-3M12 21v-4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <path d="M9 9a3 3 0 1 1 4.5 2.6c-.9.5-1.5 1.2-1.5 2.4" strokeLinecap="round" />
      <circle cx="12" cy="17.5" r="0.9" fill="currentColor" stroke="none" />
      <path d="M4 7l8-4 8 4v10l-8 4-8-4z" strokeLinejoin="round" />
    </svg>
  );
}

function tileValue(tile: DailyBonusTile): { value: string; sub: string } {
  if (tile.kind === 'mystery') return { value: '?', sub: 'Tap To Reveal' };
  if (tile.kind === 'diamonds') {
    return { value: `+${tile.diamonds}`, sub: `${diamondsToCentsLabel(tile.diamonds)} Value` };
  }
  if (tile.kind === 'time_bank') {
    return { value: `×${tile.quantity}`, sub: `${tile.quantity * 20} Seconds At The Table` };
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
  const showGranted = tile.claimed && tile.granted;
  const iconKind: DailyBonusTile['kind'] =
    showGranted && tile.granted ? tile.granted.kind : tile.kind;

  return (
    <article
      className="dbs-tile"
      data-kind={tile.kind}
      data-state={state}
      data-vip={tile.vip_only || undefined}
      data-burst={burst || undefined}
      data-revealed={revealed || undefined}
      aria-label={`${tile.label}, ${showGranted ? grantedValue(tile) : value}`}
    >
      <div className="dbs-tile__bay">
        <span className="dbs-tile__label">{tile.label}</span>
        <span className="dbs-tile__icon">
          <TileIcon kind={iconKind} />
        </span>
        <span className="dbs-tile__value">
          {showGranted && tile.granted
            ? tile.granted.kind === 'diamonds'
              ? `+${tile.granted.diamonds}`
              : `×${tile.granted.quantity}`
            : value}
        </span>
        <span className="dbs-tile__sub">
          {showGranted && tile.granted
            ? tile.granted.kind === 'diamonds'
              ? `${diamondsToCentsLabel(tile.granted.diamonds)} Credited`
              : KIND_TITLE[tile.granted.kind]
            : sub}
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
        <span className="dbs-tile__done">
          <ClubIcon name="spade" />
          Claimed
        </span>
      ) : tile.locked ? (
        <span className="dbs-tile__done dbs-tile__done--locked">VIP Members Only</span>
      ) : (
        <button
          type="button"
          className="dbs-tile__claim"
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
          <button type="button" className="dbs-tile__claim" onClick={() => void reload()}>
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
        <div className="dbs__deck">
          <div
            className="dbs__coin"
            data-lit={status.claimed_today || undefined}
            aria-label={`Day ${status.streak} Streak`}
          >
            <span className="dbs__coin-ring" aria-hidden="true" />
            <span className="dbs__coin-num">{status.streak}</span>
            <span className="dbs__coin-cap">Day Streak</span>
          </div>
          <dl className="dbs__meta">
            <div>
              <dt>Multiplier</dt>
              <dd>{status.multiplier.toFixed(1)}×</dd>
            </div>
            <div>
              <dt>Resets In</dt>
              <dd className="dbs__clock">{formatCountdown(secondsToReset)}</dd>
            </div>
            {caps && (
              <div>
                <dt>Daily Cap</dt>
                <dd>
                  {caps.daily_used} / {caps.daily_cap}
                </dd>
              </div>
            )}
          </dl>
        </div>

        <ol className="dbs__week" aria-label="This Week">
          {status.week.map((d) => (
            <li key={d.day} className="dbs__day" data-state={d.state}>
              <span className="dbs__day-num">{d.day}</span>
              <span className="dbs__day-val">{d.diamonds != null ? `+${d.diamonds}` : ''}</span>
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
          {status.claimed_today ? (
            <p>Streak Locked In For Today.</p>
          ) : (
            <p>Claim At Least One Tile Today To Keep Your Streak.</p>
          )}
          {tomorrow && (
            <p className="dbs__tomorrow">
              <span>Tomorrow</span> {tomorrow}
            </p>
          )}
        </footer>
      </>
    );
  })();

  const sheet = (
    <section
      className="dbs"
      data-mode={mode}
      role={mode === 'modal' ? 'dialog' : undefined}
      aria-modal={mode === 'modal' || undefined}
      aria-labelledby="dbs-title"
      aria-busy={loading || undefined}
    >
      <header className="dbs__plaque">
        <div>
          <span className="dbs__eyebrow">Club Arena · Every Day You Show Up</span>
          <h2 id="dbs-title" className="dbs__title">
            Daily Club Arena Bonus
          </h2>
        </div>
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
      </header>
      <div className="dbs__body">{body}</div>
    </section>
  );

  if (mode === 'inline') return sheet;
  return (
    <div className="dbs-overlay" onClick={onClose}>
      <div className="dbs-overlay__center" onClick={(e) => e.stopPropagation()}>
        {sheet}
      </div>
    </div>
  );
}
