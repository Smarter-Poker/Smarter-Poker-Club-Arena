/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DAILY CLUB ARENA BONUS - the sheet, on the spade console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-07: a reward sheet every player sees on entering Club Arena,
 * every day; diamonds, throwables, rabbit hunts and more; each tile claimed by
 * hand like the PokerBros bonus screen; premium, with depth, 3D metallic like
 * the lobby, never flat.
 *
 * Dan, 2026-09-09: "DON'T EVER USE THE SHARK, THAT WAS FOR A SPECIFIC CLUB
 * ONLY." The second cut of this sheet was assembled from the shark console's
 * plaques and button faces. This one is the #ClubArenaConsole: Dan's approved
 * spade master wearing the diamond crest (components/console/SpadeConsole),
 * and everything on it is PRINTED on the black glass between the rails - the
 * readouts, the week, every tile as a row with its painted render beside the
 * words and CLAIM as a lit word at the end, exactly the way the Promotions
 * page prints its offers. Nothing is drawn: no plaque, no card, no button
 * face. The two painted plates in the foot are the modal's only controls.
 *
 * Phase 3 (2026-09-10): a Streak Shield tile, a Mission Boost tile, and the
 * lucky multiplier the server rolls when a mystery tile is claimed. The sheet
 * shows what the ledger says it holds and what it paid; it rolls nothing.
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
import { SpadeConsole, type ConsoleInk } from '../console/SpadeConsole';
import { useToast } from '../common/Toast';
import { ThrowableImage } from '../table/ThrowableImage';
import { triggerHaptic } from '../../services/HapticService';
import { playPremiumSfx } from '../../utils/playPremiumSfx';
import { mediaUrl } from '../../utils/mediaBase';
import { reportError } from '../../utils/errorReporter';
import {
  dailyBonusService,
  diamondsToCentsLabel,
  type DailyBonusGranted,
  type DailyBonusStatus,
  type DailyBonusTile,
  type DailyBonusTileKind,
} from '../../services/DailyBonusService';
import { formatCountdown, useDailyBonus } from './useDailyBonus';
/* The sheet prints in the console's own inks, so it loads the console's sheet
   itself rather than trusting the chunk to carry it. */
import '../console/SpadeConsole.css';
import './DailyBonusSheet.css';

export interface DailyBonusSheetProps {
  /** `modal` floats over the page with a backdrop; `inline` renders as a page section. */
  mode?: 'modal' | 'inline';
  onClose?: () => void;
  /** Modal only: the sheet is mounted while open. */
  open?: boolean;
  /**
   * `console` (default): the sheet is its own spade console. `glass`: only the
   * content, for a page that already prints on a console of its own (/bonuses
   * lays it on the Rewards Circuit header's glass, so the page stays one picture).
   */
  chassis?: 'console' | 'glass';
}

const KIND_TITLE: Record<DailyBonusTileKind, string> = {
  diamonds: 'Diamonds',
  throwables: 'Throwables',
  rabbit_hunts: 'Rabbit Hunts',
  time_bank: 'Time Bank',
  mystery: 'Mystery Tile',
  shield: 'Streak Shield',
  boost: 'Mission Boost',
  free_spin: 'Bonus Spin',
};

/** The painted renders already in the kit; the throwable is a 3D render from storage. */
const ICON_SRC = {
  diamonds: mediaUrl('images/diamond-icon.png'),
  vip: mediaUrl('images/global-header/vip.png'),
  rabbit_hunts: mediaUrl('game-card-icons/rabbit-hunt.png'),
  mystery: mediaUrl('game-card-icons/mystery-bounty.png'),
  /* The shield that protects a Daily Missions streak protects this one too:
     one render for one idea, wherever a streak is kept. */
  shield: mediaUrl('images/challenges/daily-missions-streak-freeze-v1.webp'),
  free_spin: mediaUrl('images/diamond-icon.png'),
} as const;

/** The throwable tile shows the classic: the tomato render every table throws. */
const THROWABLE_ICON_ID = 'tomato';

function TileRender({
  kind,
  vip,
  seconds,
  hours,
}: {
  kind: DailyBonusTileKind;
  vip: boolean;
  seconds: number;
  hours: number;
}) {
  if (kind === 'throwables') {
    return (
      <span className="dbs-row__render">
        <ThrowableImage throwableId={THROWABLE_ICON_ID} size={96} loading="lazy" />
      </span>
    );
  }
  if (kind === 'time_bank') {
    /* The bank of seconds has no render in the kit: it is printed in the same
       engraved chrome as every value, the way the card prints its blinds. */
    return (
      <span className="dbs-row__render dbs-row__render--print sc-ink--silver" aria-hidden="true">
        +{seconds}
        <small>Sec</small>
      </span>
    );
  }
  if (kind === 'boost') {
    /* The DURATION here, never the multiplier: the multiplier is already the
       row's figure, and printing it in both slots read as a mistake. Same
       shape as the time bank above - render the total, figure the count. */
    return (
      <span className="dbs-row__render dbs-row__render--print sc-ink--blue" aria-hidden="true">
        {hours}
        <small>H</small>
      </span>
    );
  }
  const src = kind === 'diamonds' ? (vip ? ICON_SRC.vip : ICON_SRC.diamonds) : ICON_SRC[kind];
  return (
    <span className="dbs-row__render">
      <img src={src} alt="" loading="lazy" decoding="async" draggable={false} />
    </span>
  );
}

/** The figure and the line beside it, for a tile still to claim. The tile's own label names the reward. */
function offered(tile: DailyBonusTile): { figure: string; sub: string } {
  switch (tile.kind) {
    case 'mystery':
      return { figure: '?', sub: 'Claim To Reveal, With A Lucky Roll Up To 5×' };
    case 'diamonds':
      return { figure: `+${tile.diamonds}`, sub: `${diamondsToCentsLabel(tile.diamonds)} Value` };
    case 'time_bank':
      return { figure: `×${tile.quantity}`, sub: '20 Seconds Each' };
    case 'shield':
      return { figure: `×${tile.quantity}`, sub: 'Covers One Missed Day' };
    case 'boost':
      return { figure: '2×', sub: 'Double Daily Mission Diamonds' };
    case 'free_spin':
      return { figure: '×1', sub: '100 Diamond Value. Claim Before You Spin' };
    default:
      return { figure: `×${tile.quantity}`, sub: 'Yours For 7 Days' };
  }
}

/** The same two for what the ledger actually granted. */
function granted(g: DailyBonusGranted): { figure: string; sub: string } {
  switch (g.kind) {
    case 'diamonds':
      return { figure: `+${g.diamonds}`, sub: `${diamondsToCentsLabel(g.diamonds)} Credited` };
    case 'time_bank':
      return { figure: `×${g.quantity}`, sub: 'In Your Bank' };
    case 'shield':
      return { figure: `×${g.quantity}`, sub: 'Held For 30 Days' };
    case 'boost':
      return { figure: `${g.factor ?? 2}×`, sub: 'Boost Is Running' };
    case 'free_spin':
      return { figure: '×1', sub: '100 Diamond Bonus Spin Claimed' };
    default:
      return { figure: `×${g.quantity}`, sub: 'Yours For 7 Days' };
  }
}

function grantedWords(g: DailyBonusGranted): string {
  const { figure } = granted(g);
  return g.kind === 'diamonds' ? `${figure} Diamonds` : `${figure} ${KIND_TITLE[g.kind]}`;
}

interface RowProps {
  tile: DailyBonusTile;
  busy: boolean;
  disabled: boolean;
  onClaim: (tile: DailyBonusTile) => void;
  burst: boolean;
  revealed: boolean;
}

/**
 * A ROW on the glass, not a card: the render beside the words, the figure and
 * its unit on one line, the value line under them, CLAIM a lit word at the end.
 */
function BonusRow({ tile, busy, disabled, onClaim, burst, revealed }: RowProps) {
  const state = tile.claimed
    ? 'claimed'
    : tile.locked
      ? 'locked'
      : busy
        ? 'busy'
        : tile.capped
          ? 'capped'
          : 'ready';
  const g = tile.claimed ? tile.granted : null;
  const lines = g ? granted(g) : offered(tile);
  const renderKind: DailyBonusTileKind = g ? g.kind : tile.kind;
  const seconds = (g ? g.quantity : tile.quantity) * 20;
  const lucky = g?.lucky ?? tile.revealed?.lucky ?? 0;
  const typeInk: ConsoleInk = tile.vip_only ? 'gold' : 'blue';

  return (
    <article
      className="dbs-row"
      data-kind={tile.kind}
      data-state={state}
      data-vip={tile.vip_only || undefined}
      data-burst={burst || undefined}
      data-revealed={revealed || undefined}
      aria-label={`${tile.label}, ${g ? grantedWords(g) : `${lines.figure} ${lines.sub}`}`}
    >
      <TileRender
        kind={renderKind}
        vip={tile.vip_only}
        seconds={seconds}
        hours={g ? (g.hours ?? g.quantity) : tile.quantity}
      />
      <span className="dbs-row__lines">
        <span className={`sc-label sc-ink--${typeInk} dbs-row__type`}>{tile.label}</span>
        <span className="dbs-row__title">
          <span
            className={`dbs-row__figure ${tile.kind === 'diamonds' || g?.kind === 'diamonds' ? 'sc-ink--white' : 'sc-ink--silver'}`}
          >
            {lines.figure}
          </span>
          <span className="sc-copy dbs-row__sub">{lines.sub}</span>
        </span>
        {tile.kind === 'mystery' && lucky > 1 && (
          <span className="sc-label sc-ink--gold dbs-row__lucky">Lucky Roll ×{lucky}</span>
        )}
        {tile.capped && !tile.claimed && (
          <span className="sc-label sc-ink--gold dbs-row__note">Daily Cap Trims This One</span>
        )}
      </span>
      {burst && (
        <span className="dbs-row__sparks" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <i key={i} style={{ '--i': i } as CSSProperties} />
          ))}
        </span>
      )}
      {tile.claimed ? (
        <span className="dbs-word sc-ink--green dbs-row__action">Claimed</span>
      ) : tile.locked ? (
        <span className="dbs-word sc-ink--gold dbs-row__action dbs-row__action--locked">
          VIP Members Only
        </span>
      ) : (
        <button
          type="button"
          className={`dbs-word sc-ink--white dbs-row__action${busy ? ' dbs-word--busy' : ''}`}
          onClick={() => onClaim(tile)}
          disabled={disabled || busy}
          aria-busy={busy || undefined}
        >
          {busy ? 'Claiming' : tile.capped ? 'Claim What Fits' : 'Claim'}
        </button>
      )}
    </article>
  );
}

function tomorrowWords(status: DailyBonusStatus): string {
  return status.tomorrow
    .filter((t) => !t.vip_only || status.is_vip)
    .map((t) =>
      t.kind === 'diamonds'
        ? `+${t.diamonds} Diamonds`
        : t.kind === 'mystery'
          ? 'A Mystery Tile'
          : t.kind === 'boost'
            ? 'A Mission Boost'
            : `×${t.quantity} ${t.label}`
    )
    .join(' · ');
}

/** ×2 rather than ×2.0; a streak multiplier of 1.5 keeps its one decimal because it is one. */
function formatMultiplier(m: number): string {
  const n = Number(m) || 1;
  return Number.isInteger(n) ? `×${n}` : `×${n.toFixed(1)}`;
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function DailyBonusSheet({
  mode = 'modal',
  onClose,
  open = true,
  chassis = 'console',
}: DailyBonusSheetProps) {
  const toast = useToast();
  const enabled = mode === 'inline' || open;
  const {
    status,
    loading,
    loadError,
    reload,
    claim,
    claimingSlot,
    secondsToReset,
    boostSecondsLeft,
  } = useDailyBonus(enabled);
  const [burstSlot, setBurstSlot] = useState<number | null>(null);
  const [revealSlot, setRevealSlot] = useState<number | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const burstTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [spinClubs, setSpinClubs] = useState<Array<{ id: string; name: string }> | null>(null);
  const [choosingSpinClub, setChoosingSpinClub] = useState(false);
  const [spinClubsError, setSpinClubsError] = useState(false);
  const chooseSpinClub = async () => {
    setChoosingSpinClub(true);
    setSpinClubsError(false);
    try {
      const { ClubsService } = await import('../../services/ClubsService');
      const memberships = await ClubsService.getUserMemberships();
      setSpinClubs(
        memberships
          .filter((m) => m.club && m.club.id !== m.club.union_id)
          .map((m) => ({ id: m.club.id, name: m.club.name }))
      );
    } catch (err) {
      reportError(err, 'DailyBonusSheet.chooseSpinClub');
      setSpinClubsError(true);
    } finally {
      setChoosingSpinClub(false);
    }
  };

  useEffect(() => {
    return () => {
      if (burstTimer.current) clearTimeout(burstTimer.current);
    };
  }, []);

  // The sheet is in front of the player: today is spent, on every device.
  // Once per day per mount; the server keeps the first mark.
  const shownFor = useRef<string | null>(null);
  const statusToday = status?.eligible ? status.today : null;
  const statusShown = status?.shown_today ?? true;
  useEffect(() => {
    if (!statusToday || statusShown || shownFor.current === statusToday) return;
    shownFor.current = statusToday;
    void dailyBonusService.markShown();
  }, [statusToday, statusShown]);

  // Modal chrome: lock scroll, focus the first control, Escape closes.
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
        const lucky = g.lucky ?? 0;
        toast.success(
          g.kind === 'diamonds'
            ? `Claimed +${g.diamonds} Diamonds (${diamondsToCentsLabel(g.diamonds)})${lucky > 1 ? `, Lucky ×${lucky}` : ''}`
            : g.kind === 'boost'
              ? `Mission Boost Is Live, ${g.factor ?? 2}× Diamonds For ${g.hours ?? g.quantity} Hours`
              : g.kind === 'shield'
                ? `Claimed ×${g.quantity} Streak Shield, Held For 30 Days`
                : `Claimed ×${g.quantity} ${KIND_TITLE[g.kind]}${lucky > 1 ? `, Lucky ×${lucky}` : ''}`
        );
      } else if (outcome.result.reason === 'day_rolled_over') {
        // Midnight passed under the sheet; the hook has re-read today's tiles.
        triggerHaptic('light');
        toast.info(outcome.refusal);
      } else {
        triggerHaptic('error');
        toast.error(outcome.refusal);
      }
    },
    [claim, toast]
  );

  if (mode === 'modal' && !open) return null;

  const nextClaimable = status?.eligible
    ? (status.tiles.find((t) => !t.claimed && !t.locked) ?? null)
    : null;

  const glass: ReactNode = (() => {
    if (loadError) {
      return (
        <div className="dbs__state" role="alert">
          <p className="sc-ink--silver">{loadError}</p>
          <button type="button" className="dbs-word sc-ink--white" onClick={() => void reload()}>
            Try Again
          </button>
        </div>
      );
    }
    if (!status) {
      return (
        <div className="dbs__state" role="status" aria-live="polite">
          <span className="dbs__spinner" aria-hidden="true" />
          <p className="sc-ink--silver">Setting The Table</p>
        </div>
      );
    }
    if (!status.eligible) {
      return (
        <div className="dbs__state" role="status">
          <p className="sc-ink--silver">The Daily Bonus Is Not Available On This Account.</p>
        </div>
      );
    }
    const caps = status.caps;
    const tomorrow = tomorrowWords(status);
    const boost = status.boost;
    const boostLive = boost.active && boostSecondsLeft > 0;
    return (
      <>
        <dl className="dbs__readouts">
          <div className="dbs__readout" aria-label={`Day ${status.streak} Streak`}>
            <dt className="sc-label sc-ink--blue">Streak</dt>
            <dd
              className={`dbs__figure ${status.claimed_today ? 'sc-ink--white' : 'sc-ink--silver'}`}
            >
              Day {status.streak}
            </dd>
            {status.streak_protected && (
              <dd className="sc-label sc-ink--gold dbs__readout-note">Shield Covered Yesterday</dd>
            )}
          </div>
          <div className="dbs__readout">
            <dt className="sc-label sc-ink--blue">Multiplier</dt>
            <dd className="dbs__figure sc-ink--silver">{formatMultiplier(status.multiplier)}</dd>
          </div>
          <div className="dbs__readout">
            <dt className="sc-label sc-ink--blue">Resets In</dt>
            <dd
              className={`dbs__figure dbs__clock ${secondsToReset <= 10 ? 'sc-ink--red' : 'sc-ink--gold'}`}
            >
              {formatCountdown(secondsToReset)}
            </dd>
          </div>
        </dl>

        <ol className="dbs__week" aria-label="This Week">
          {status.week.map((d) => (
            <li
              key={d.day}
              className="dbs__day"
              data-state={d.state}
              data-chest={d.chest || undefined}
              data-protected={(d.state === 'today' && status.streak_protected) || undefined}
            >
              <span
                className={`sc-label dbs__day-label ${
                  d.chest
                    ? 'sc-ink--gold'
                    : d.state === 'done'
                      ? 'sc-ink--green'
                      : d.state === 'today'
                        ? 'sc-ink--blue'
                        : 'sc-ink--muted'
                }`}
              >
                {d.chest ? 'Chest' : `Day ${d.day}`}
              </span>
              <span
                className={`dbs__day-value ${
                  d.state === 'done'
                    ? 'sc-ink--green'
                    : d.state === 'today'
                      ? 'sc-ink--white'
                      : 'sc-ink--muted'
                }`}
              >
                {d.diamonds != null ? `+${d.diamonds}` : ''}
              </span>
            </li>
          ))}
        </ol>

        <div className="dbs__tiles">
          {status.tiles.map((tile) => (
            <BonusRow
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

        <dl className="dbs__notes">
          <div className="dbs__note">
            <dt className="sc-label sc-ink--blue">Bonus Spin</dt>
            <dd className="sc-copy">
              Every Tenth Streak Day Adds One 100 Diamond Bonus Spin. Claim It Here, Then Use It In
              Your Club. Your Welcome Spin Stays Separate.
            </dd>
          </div>
          {(status.bonus_spins_held ?? 0) > 0 && (
            <div className="dbs__note">
              <dt className="sc-label sc-ink--gold">Spins</dt>
              <dd className="sc-copy">
                <button
                  type="button"
                  className="dbs-word sc-ink--gold"
                  disabled={choosingSpinClub}
                  onClick={() => void chooseSpinClub()}
                >
                  {choosingSpinClub
                    ? 'Loading Clubs'
                    : spinClubsError
                      ? 'Retry Clubs'
                      : 'Use Bonus Spin'}
                </button>
                {spinClubsError && <p role="alert">Your Clubs Could Not Be Loaded. Try Again.</p>}
                {spinClubs?.map((club) => (
                  <p key={club.id}>
                    <a
                      className="dbs-word sc-ink--blue"
                      href={`${import.meta.env.BASE_URL}clubs/${club.id}/wheel?spin=daily-bonus`}
                    >
                      {club.name}
                    </a>
                  </p>
                ))}
                {spinClubs?.length === 0 && (
                  <p>
                    <a
                      className="dbs-word sc-ink--blue"
                      href={`${import.meta.env.BASE_URL}clubs-list`}
                    >
                      Join A Club To Use Your Spin
                    </a>
                  </p>
                )}
              </dd>
            </div>
          )}
          <div className="dbs__note">
            <dt className="sc-label sc-ink--blue">Streak</dt>
            <dd className="sc-copy">
              {status.claimed_today
                ? 'Streak Locked In For Today.'
                : 'Claim At Least One Tile Today To Keep Your Streak.'}
            </dd>
          </div>
          {status.shield.held > 0 && (
            <div className="dbs__note">
              <dt className="sc-label sc-ink--gold">Shield</dt>
              <dd className="sc-copy">
                {status.shield.held === 1
                  ? 'One Shield Held. It Covers One Missed Day'
                  : `${status.shield.held} Shields Held. Each Covers One Missed Day`}
                {status.shield.expires_at
                  ? `, Good Until ${shortDate(status.shield.expires_at)}.`
                  : '.'}
              </dd>
            </div>
          )}
          {boostLive && (
            <div className="dbs__note">
              <dt className="sc-label sc-ink--gold">Boost</dt>
              <dd className="sc-copy">
                {boost.factor ?? 2}× Daily Mission Diamonds For Another{' '}
                <span className="dbs__note-clock sc-ink--gold">
                  {formatCountdown(boostSecondsLeft)}
                </span>
                {typeof boost.applied_diamonds === 'number' && boost.applied_diamonds > 0
                  ? `. +${boost.applied_diamonds} Diamonds So Far.`
                  : '.'}
              </dd>
            </div>
          )}
          {tomorrow && (
            <div className="dbs__note">
              <dt className="sc-label sc-ink--blue">Tomorrow</dt>
              <dd className="sc-copy">{tomorrow}</dd>
            </div>
          )}
          {caps && (
            <div className="dbs__note">
              <dt className="sc-label sc-ink--blue">Daily Cap</dt>
              <dd className="sc-copy">
                {caps.daily_used} / {caps.daily_cap} Diamonds Today
              </dd>
            </div>
          )}
        </dl>
      </>
    );
  })();

  if (chassis === 'glass' && mode === 'inline') {
    return (
      <div className="dbs dbs--glass" data-mode="inline" aria-busy={loading || undefined}>
        {glass}
      </div>
    );
  }

  const pill = status?.eligible ? `Day ${status.streak}` : undefined;
  const pillInk: ConsoleInk = status?.streak_day
    ? 'gold'
    : status?.claimed_today
      ? 'green'
      : 'blue';
  const claiming = claimingSlot !== null;
  const primaryLabel = claiming ? 'Claiming' : nextClaimable ? 'Claim Next' : 'Done';

  const sheet = (
    <div
      ref={sheetRef}
      className="dbs"
      data-mode={mode}
      role={mode === 'modal' ? 'dialog' : undefined}
      aria-modal={mode === 'modal' || undefined}
      aria-labelledby="dbs-title"
      aria-busy={loading || undefined}
    >
      <SpadeConsole
        as="section"
        crest="diamond"
        eyebrow="Club Arena"
        title="Daily Bonus"
        titleId="dbs-title"
        pill={pill}
        pillInk={pillInk}
        foot={mode === 'modal' ? 'plates' : 'foot'}
        plates={
          mode === 'modal'
            ? {
                secondary: {
                  label: 'Not Now',
                  ink: 'silver',
                  buttonRef: closeRef,
                  onClick: onClose,
                  'aria-label': 'Close',
                },
                primary: {
                  label: primaryLabel,
                  ink: 'white',
                  disabled: claiming || (!nextClaimable && !onClose),
                  onClick: () => {
                    if (nextClaimable) void handleClaim(nextClaimable);
                    else onClose?.();
                  },
                },
              }
            : undefined
        }
        className="dbs__console"
      >
        {glass}
      </SpadeConsole>
    </div>
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
