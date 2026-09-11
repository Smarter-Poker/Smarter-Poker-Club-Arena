/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND PLINKO + DIAMOND CRASH - the operator's console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * One page, two games, a switch on the plates. What a host owner needs to run
 * them and nothing else: open and close each game, the bet sizes, the exposure
 * allowance (the most the host accepts being ahead of what the game has taken
 * in), the cap fraction, the multiplier ceiling, the crash curve, the
 * per-player limits, and the readings that say whether the game is doing what
 * its odds promise: realised return against the 80 percent spec as a z-score
 * per window, the constrained rate, exposure headroom, open rounds still
 * holding a reservation, and the invariant (paid + reserved <= taken in +
 * allowance) that the arithmetic makes impossible to break and
 * fn_diamond_game_metrics re-derives anyway. AMENDED 2026-09-10: nothing is
 * minted any more. The diamonds a round takes in are the host owner's, and
 * every chip a game pays leaves the host's promo wallet, which is why that
 * wallet and the owner's diamonds are the two figures at the top of this page.
 *
 * Every control posts a patch to fn_diamond_game_set_config, which decides who
 * may (fn_wheel_can_operate). The page shows a refusal, it never pre-empts one.
 *
 * THE PICTURE (#ClubArenaConsole). Four consoles: the readings (its plates are
 * the Plinko / Crash switch, the chosen game in white), the realised return by
 * window, the controls (fields printed on engraved lines, Close / Open on the
 * steel, Save on the blue glass) and the lifetime pool. Nothing is drawn.
 *
 * Route: /clubs/:clubId/diamond-games-operations, finance access in the
 * operations registry. The players' pages are /clubs/:clubId/plinko and
 * /clubs/:clubId/crash. The wheel has its own console at /wheel-operations.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../../components/common/Toast';
import { ErrorState, LoadingState } from '../../components/common/EmptyState';
import { SpadeConsole, type ConsoleInk } from '../../components/console/SpadeConsole';
import DiamondGamesService, {
  type DiamondGame,
  type GameConfigPatch,
  type GameMetrics,
} from '../../services/DiamondGamesService';
import { multiplierLabel } from '../../utils/diamondGamesFairness';
import { compactChips } from '../../utils/format';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { reportError } from '../../utils/errorReporter';
import { uuid } from '../../utils/uuid';
import { useIsMounted } from '../../hooks/useIsMounted';
import styles from '../diamondGames.module.css';

const chips = (n: number | null | undefined) => compactChips(Number(n ?? 0));
const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? 'N/A' : `${Math.round(n * 100)}%`;

interface Draft {
  bet_options: string;
  min_bet_diamonds: string;
  max_bet_diamonds: string;
  exposure_allowance_chips: string;
  cap_fraction: string;
  max_multiplier: string;
  growth_k: string;
  max_rounds_per_player_per_day: string;
  min_seconds_between_rounds: string;
  purchased_only: boolean;
  allow_fixture_accounts: boolean;
}

function draftFrom(m: GameMetrics | null): Draft {
  const c = m?.config;
  return {
    bet_options: (c?.bet_options ?? [100, 200, 500, 1000]).join(', '),
    min_bet_diamonds: String(c?.min_bet_diamonds ?? 100),
    max_bet_diamonds: String(c?.max_bet_diamonds ?? 1000),
    exposure_allowance_chips: String(c?.exposure_allowance_chips ?? 1250),
    cap_fraction: String(c?.cap_fraction ?? 0.95),
    max_multiplier: String((c?.max_multiplier_cents ?? 100000) / 100),
    growth_k: String(c?.growth_k ?? 0.12),
    max_rounds_per_player_per_day: String(c?.max_rounds_per_player_per_day ?? 500),
    min_seconds_between_rounds: String(c?.min_seconds_between_rounds ?? 2),
    purchased_only: c?.purchased_only ?? true,
    allow_fixture_accounts: c?.allow_fixture_accounts ?? false,
  };
}

const GAME_WORD: Record<DiamondGame, string> = { plinko: 'Plinko', crash: 'Crash' };

function Row({
  label,
  value,
  ink = 'silver',
  meta,
}: {
  label: string;
  value: string;
  ink?: ConsoleInk;
  meta?: string;
}) {
  return (
    <div className={styles.row}>
      <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>
        {label}
        {meta ? <span className={`${styles.rowMeta} sc-ink--muted`}>{meta}</span> : null}
      </span>
      <span className={`${styles.rowValue} sc-ink--${ink}`}>{value}</span>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  hint,
  mode = 'decimal',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  mode?: 'decimal' | 'numeric' | 'text';
}) {
  return (
    <label className={styles.field}>
      <span className="sc-label sc-ink--blue">{label}</span>
      <input
        className={styles.fieldInput}
        inputMode={mode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <span className="sc-copy sc-ink--muted">{hint}</span> : null}
    </label>
  );
}

/** A switch: the row IS the control, its state is its printed value. */
function Toggle({
  label,
  hint,
  on,
  onToggle,
}: {
  label: string;
  hint: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" className={styles.rowButton} onClick={onToggle} aria-pressed={on}>
      <span className={`sc-label sc-ink--silver ${styles.rowLabel}`}>
        {label}
        <span className={`${styles.rowMeta} sc-ink--muted`}>{hint}</span>
      </span>
      <span className={`${styles.rowValue} sc-ink--${on ? 'green' : 'muted'}`}>
        {on ? 'On' : 'Off'}
      </span>
    </button>
  );
}

export default function ClubDiamondGamesOperationsPage() {
  const { clubId: routeClubId } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const isMountedRef = useIsMounted();

  const [game, setGame] = useState<DiamondGame>('plinko');
  const [clubUuid, setClubUuid] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<GameMetrics | null>(null);
  const [draft, setDraft] = useState<Draft>(draftFrom(null));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [fundChips, setFundChips] = useState('');
  const [funding, setFunding] = useState(false);
  /**
   * ONE KEY PER INTENT, HELD ACROSS A FAILURE (2026-09-11). The server spends a
   * funding key once and answers a second press under the same key with
   * replayed = true, having moved nothing. So a press whose reply was lost has
   * to be retried under the SAME key: mint on a new amount, keep on a thrown
   * request, clear only once the server has actually answered.
   */
  const fundKeyRef = useRef<{ amount: number; key: string } | null>(null);

  const load = useCallback(
    async (which: DiamondGame) => {
      if (!routeClubId) return;
      setLoading(true);
      setError(null);
      try {
        const uuid = clubUuid ?? (await resolveClubUUID(routeClubId));
        if (!isMountedRef.current) return;
        setClubUuid(uuid);
        const m = await DiamondGamesService.metrics(uuid, which);
        if (!isMountedRef.current) return;
        if (!m.ok) {
          setError(m.error || 'The Readings Could Not Be Loaded');
          return;
        }
        setMetrics(m);
        setDraft(draftFrom(m));
      } catch (err) {
        reportError(err, 'ClubDiamondGamesOperationsPage.load');
        if (isMountedRef.current) setError('The Readings Could Not Be Loaded');
      } finally {
        if (isMountedRef.current) setLoading(false);
      }
    },
    [routeClubId, clubUuid, isMountedRef]
  );

  useEffect(() => {
    void load(game);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, routeClubId]);

  const apply = useCallback(
    async (patch: GameConfigPatch, done: string) => {
      if (!clubUuid) return;
      setSaving(true);
      try {
        const res = await DiamondGamesService.setConfig(clubUuid, game, patch);
        if (!isMountedRef.current) return;
        if (!res.ok) {
          toast.error(res.error || 'That Change Was Refused');
          return;
        }
        toast.success(done);
        await load(game);
      } catch (err) {
        reportError(err, 'ClubDiamondGamesOperationsPage.apply');
        if (isMountedRef.current) toast.error('That Change Did Not Go Through');
      } finally {
        if (isMountedRef.current) setSaving(false);
      }
    },
    [clubUuid, game, isMountedRef, toast, load]
  );

  /** Bank into promo wallet. The server decides who may; this only asks. */
  const moveIntoPromo = useCallback(
    async (amount: number) => {
      if (!clubUuid) return;
      if (!Number.isFinite(amount) || amount <= 0)
        return toast.error('Enter How Many Chips To Move');
      const held = fundKeyRef.current;
      const intent = held && held.amount === amount ? held : { amount, key: uuid() };
      fundKeyRef.current = intent;
      setFunding(true);
      try {
        const res = await DiamondGamesService.fundPromo(clubUuid, amount, intent.key);
        // The server answered, so this intent is closed either way: a refusal
        // moved nothing, and a success must never be sent a second time.
        fundKeyRef.current = null;
        if (!isMountedRef.current) return;
        if (!res.ok) {
          toast.error(res.error ?? 'Those Chips Could Not Be Moved');
        } else {
          toast.success(
            res.replayed ? 'Those Chips Were Already Moved' : 'The Promo Wallet Is Funded'
          );
          setFundChips('');
          await load(game);
        }
      } catch (err) {
        // No answer came back, so nobody knows whether the chips moved. The key
        // is deliberately kept: the next press is the same intent, not a new one.
        reportError(err, 'ClubDiamondGamesOperationsPage.fundPromo');
        if (isMountedRef.current) toast.error('Those Chips Could Not Be Moved');
      } finally {
        if (isMountedRef.current) setFunding(false);
      }
    },
    [clubUuid, game, isMountedRef, toast, load]
  );

  const saveNumbers = () => {
    const bets = draft.bet_options
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (!bets.length || bets.some((b) => !Number.isInteger(b) || b <= 0))
      return toast.error('Bet Sizes Must Be Whole Numbers Of Diamonds');
    const minBet = Number(draft.min_bet_diamonds);
    const maxBet = Number(draft.max_bet_diamonds);
    const allowance = Number(draft.exposure_allowance_chips);
    const capFraction = Number(draft.cap_fraction);
    const maxMult = Number(draft.max_multiplier);
    const growthK = Number(draft.growth_k);
    const rounds = Number(draft.max_rounds_per_player_per_day);
    const gap = Number(draft.min_seconds_between_rounds);
    if (!Number.isInteger(minBet) || minBet <= 0 || !Number.isInteger(maxBet) || maxBet < minBet)
      return toast.error('The Bet Limits Must Be Whole Numbers Of Diamonds, Max At Least Min');
    if (!Number.isFinite(allowance) || allowance < 0)
      return toast.error('The Exposure Allowance Must Be Zero Or More');
    if (!Number.isFinite(capFraction) || capFraction <= 0 || capFraction >= 1)
      return toast.error('The Cap Fraction Must Be Between 0 And 1');
    if (!Number.isFinite(maxMult) || maxMult < 1.01)
      return toast.error('The Multiplier Ceiling Must Be At Least 1.01');
    if (!Number.isFinite(growthK) || growthK <= 0) return toast.error('The Curve Must Climb');
    if (!Number.isInteger(rounds) || rounds <= 0)
      return toast.error('The Daily Limit Must Be A Whole Number Of Rounds');
    if (!Number.isInteger(gap) || gap < 0)
      return toast.error('The Pause Between Rounds Must Be Zero Or More Seconds');
    void apply(
      {
        bet_options: bets,
        min_bet_diamonds: minBet,
        max_bet_diamonds: maxBet,
        exposure_allowance_chips: Math.round(allowance * 100) / 100,
        cap_fraction: Math.round(capFraction * 1000) / 1000,
        max_multiplier_cents: Math.round(maxMult * 100),
        growth_k: Math.round(growthK * 10000) / 10000,
        max_rounds_per_player_per_day: rounds,
        min_seconds_between_rounds: gap,
        purchased_only: draft.purchased_only,
        allow_fixture_accounts: draft.allow_fixture_accounts,
      },
      `${GAME_WORD[game]} Settings Saved`
    );
  };

  if (loading && !metrics) return <LoadingState message="Reading The Games" />;
  if (error) {
    return (
      <div className={styles.page}>
        <ErrorState message={error} onRetry={() => void load(game)} />
      </div>
    );
  }

  const cfg = metrics?.config;
  const pool = metrics?.pool;
  const enabled = Boolean(cfg?.enabled);
  const word = GAME_WORD[game];
  const hostWord = metrics?.host_kind === 'union' ? 'Union' : 'Club';
  const promoDry = (metrics?.promo_chips ?? 0) <= 0;
  const set = (key: keyof Draft) => (v: string) => setDraft((d) => ({ ...d, [key]: v }));

  return (
    <div className={styles.page}>
      <button
        type="button"
        className={styles.back}
        onClick={() => navigate(`/clubs/${routeClubId}/operations`)}
      >
        ‹ Operations
      </button>

      <SpadeConsole
        eyebrow="Operations"
        title={`Diamond ${word}`}
        titleId="diamond-games-ops-title"
        pill={enabled ? 'Open' : 'Closed'}
        pillInk={enabled ? 'green' : 'red'}
        aria-labelledby="diamond-games-ops-title"
        plates={{
          secondary: {
            label: 'Plinko',
            ink: game === 'plinko' ? 'white' : 'muted',
            onClick: () => setGame('plinko'),
            disabled: loading,
            'aria-pressed': game === 'plinko',
          },
          primary: {
            label: 'Crash',
            ink: game === 'crash' ? 'white' : 'muted',
            onClick: () => setGame('crash'),
            disabled: loading,
            'aria-pressed': game === 'crash',
          },
        }}
      >
        <div className={styles.rows}>
          <Row
            label="Cover"
            value={chips(metrics?.cover_chips)}
            ink={(metrics?.cover_chips ?? 0) <= 0 ? 'red' : 'silver'}
            meta={`${chips(metrics?.promo_chips)} Promo Plus ${chips(metrics?.bank_chips)} Bank`}
          />
          <Row
            label={`${hostWord} Promo Wallet`}
            value={chips(metrics?.promo_chips)}
            ink={promoDry ? 'gold' : 'silver'}
            meta={
              promoDry
                ? `Empty, So The ${hostWord} Bank Is Paying`
                : 'Every Payout Is Paid From Here First'
            }
          />
          <Row
            label={`${hostWord} Bank`}
            value={chips(metrics?.bank_chips)}
            ink={(metrics?.bank_chips ?? 0) <= 0 ? 'red' : 'blue'}
            meta="Behind The Promo Wallet, And Only When It Runs Dry"
          />
          <Row
            label="Owner Diamonds"
            value={compactChips(metrics?.owner_diamonds ?? 0)}
            ink="blue"
            meta="Where The Diamonds Taken In Land"
          />
          <Row
            label="Exposure"
            value={chips(metrics?.exposure_chips)}
            ink={(metrics?.exposure_chips ?? 0) > 0 ? 'gold' : 'silver'}
            meta={`Room ${chips(metrics?.exposure_headroom_chips)}`}
          />
          <Row
            label="Return"
            value={pct(metrics?.realized_rtp_lifetime)}
            meta={`${compactChips(pool?.rounds ?? 0)} Rounds Against 80%`}
          />
          <Row
            label="House Take"
            value={chips(metrics?.house_take_lifetime_chips)}
            ink="gold"
            meta="Chips"
          />
          <Row
            label="Capped"
            value={pct(metrics?.constrained_rate)}
            meta={game === 'crash' ? `${metrics?.open_rounds ?? 0} Open` : 'Of Rounds'}
          />
          <Row
            label="Invariant"
            value={metrics?.invariant_ok === false ? 'Broken' : 'Holds'}
            ink={metrics?.invariant_ok === false ? 'red' : 'green'}
            meta="Paid Plus Held"
          />
        </div>
        <p className="sc-copy">
          Paid Plus Reserved Never Exceeds What Was Taken In Plus The Allowance, And Every Chip
          Leaves The Promo Wallet Before The Bank; The Per-Round Cap Makes That Arithmetic, And The
          Metrics Re-Derive It. Capped Rounds Are Ones The Pool Could Not Promise The Full Ceiling
          On.
        </p>
      </SpadeConsole>

      {/* THE FLOAT, AND WHERE TO PUT IT (Dan 2026-09-10). The bank backs the
          promo wallet on its own, so the games never stop; this is how an
          operator moves the float to where it is meant to sit. */}
      <SpadeConsole
        eyebrow="Cover"
        title="The Promo Wallet"
        pill={promoDry ? 'On The Bank' : 'Funded'}
        pillInk={promoDry ? 'gold' : 'green'}
        plates={{
          secondary: {
            label: 'Move 100',
            onClick: () => void moveIntoPromo(100),
            disabled: funding,
          },
          primary: {
            label: funding ? 'Moving' : 'Move The Amount',
            ink: 'white',
            onClick: () => void moveIntoPromo(Number(fundChips)),
            disabled: funding,
          },
        }}
      >
        <p className="sc-copy">
          Every Payout Leaves The Promo Wallet First. When It Runs Dry The {hostWord} Bank Pays The
          Rest, So The Games Never Stop; The Journal Names Which Wallet Paid Which Part. Keep The
          Float Here And The Bank Stays A Backstop Rather Than A Habit.
        </p>
        <div className={styles.fields}>
          <Field
            label="Move Into The Promo Wallet (Chips)"
            value={fundChips}
            onChange={setFundChips}
            hint="Taken From The Bank, Which Is The Same Money In A Different Pocket."
          />
        </div>
      </SpadeConsole>

      <SpadeConsole eyebrow="Against The 80% Spec" title="Realised Return" foot="foot">
        <div className={styles.rows}>
          <div className={`${styles.grid4} ${styles.grid4Head}`}>
            <span className="sc-label sc-ink--blue">Window</span>
            <span className={`sc-label sc-ink--blue ${styles.cellRight}`}>Rounds</span>
            <span className={`sc-label sc-ink--blue ${styles.cellRight}`}>Return</span>
            <span className={`sc-label sc-ink--blue ${styles.cellRight}`}>Z</span>
          </div>
          {(metrics?.windows ?? []).map((w) => (
            <div key={w.window} className={styles.grid4}>
              <span className={`${styles.cell} ${w.drift ? 'sc-ink--red' : 'sc-ink--silver'}`}>
                {w.window.toUpperCase()}
                <span className={`${styles.rowMeta} sc-ink--muted`}>
                  In {chips(w.intake_chips)}, Out {chips(w.paid_chips)}
                  {w.constrained ? `, ${compactChips(w.constrained)} Capped` : ''}
                  {game === 'crash' && w.instant_crashes
                    ? `, ${compactChips(w.instant_crashes)} Instant`
                    : ''}
                </span>
              </span>
              <span className={`${styles.cell} ${styles.cellRight} sc-ink--silver`}>
                {compactChips(w.rounds)}
              </span>
              <span
                className={`${styles.cell} ${styles.cellRight} ${w.drift ? 'sc-ink--red' : 'sc-ink--silver'}`}
              >
                {pct(w.realized_rtp)}
              </span>
              <span
                className={`${styles.cell} ${styles.cellRight} ${w.drift ? 'sc-ink--red' : 'sc-ink--muted'}`}
              >
                {w.z === null ? 'N/A' : w.z.toFixed(1)}
              </span>
            </div>
          ))}
        </div>
        <p className="sc-copy">
          Z Is The Realised Return Against 80% In Standard Errors. Under 2,000 Rounds It Is Noise;
          Past 2,000, Z Of 4 Or More Either Way Flags Drift And Prints The Window In Red.
          {game === 'crash'
            ? ' A Crashed Round Is Scored At Its Own Crash Point, The Most It Could Have Asked For, So Z Runs Conservative.'
            : ''}
        </p>
        {game === 'plinko' && metrics?.tables?.length ? (
          <div className={`${styles.rows} ${styles.rowsCompact}`}>
            {metrics.tables.map((t) => (
              <Row
                key={t.version}
                label={t.name}
                value={multiplierLabel(t.max_multiplier_cents)}
                ink={t.activated_at ? 'gold' : 'muted'}
                meta={`Returns ${pct(t.spec_rtp)}, Pays ${pct(t.hit_rate)} Of Drops${t.activated_at ? '' : ', Not Yet Live'}`}
              />
            ))}
          </div>
        ) : null}
      </SpadeConsole>

      <SpadeConsole
        eyebrow={`${word} Is ${enabled ? 'Open' : 'Closed'}`}
        title="Controls"
        plates={{
          secondary: {
            label: enabled ? `Close ${word}` : `Open ${word}`,
            ink: enabled ? 'red' : 'gold',
            disabled: saving,
            onClick: () =>
              void apply({ enabled: !enabled }, enabled ? `${word} Is Closed` : `${word} Is Open`),
          },
          primary: {
            label: saving ? 'Saving' : 'Save Settings',
            ink: 'white',
            onClick: saveNumbers,
            disabled: saving,
          },
        }}
      >
        <p className="sc-copy">
          {enabled
            ? 'Closing It Refuses The Next Round At Once. Rounds Already Open Settle As Normal.'
            : 'Nobody Can Play Until You Open It.'}
        </p>
        <div className={styles.fields}>
          <Field
            label="Bet Sizes (Diamonds, Comma Separated)"
            mode="text"
            value={draft.bet_options}
            onChange={set('bet_options')}
            hint="Whole Chips Only: Multiples Of 100 Diamonds."
          />
          <Field
            label="Exposure Allowance (Chips)"
            value={draft.exposure_allowance_chips}
            onChange={set('exposure_allowance_chips')}
            hint={`The Most ${word} May Pay Beyond What It Has Taken In.`}
          />
          <Field
            label="Minimum Bet (Diamonds)"
            mode="numeric"
            value={draft.min_bet_diamonds}
            onChange={set('min_bet_diamonds')}
          />
          <Field
            label="Maximum Bet (Diamonds)"
            mode="numeric"
            value={draft.max_bet_diamonds}
            onChange={set('max_bet_diamonds')}
          />
          <Field
            label="Cap Fraction"
            value={draft.cap_fraction}
            onChange={set('cap_fraction')}
            hint="The Share Of The Pool Headroom One Round May Be Promised. 0.95 Keeps The Pool Alive After A Full Hit."
          />
          <Field
            label="Multiplier Ceiling"
            value={draft.max_multiplier}
            onChange={set('max_multiplier')}
            hint={
              game === 'crash'
                ? 'Where A Round Auto Cashes If It Never Crashed.'
                : 'Never Above The Board Itself.'
            }
          />
          {game === 'crash' ? (
            <Field
              label="Curve (K Per Second)"
              value={draft.growth_k}
              onChange={set('growth_k')}
              hint="Multiplier = Exp(K Times Seconds). 0.12 Reaches 2x In 5.8s And 1000x In 57.6s."
            />
          ) : null}
          <Field
            label="Rounds Per Player Per Day"
            mode="numeric"
            value={draft.max_rounds_per_player_per_day}
            onChange={set('max_rounds_per_player_per_day')}
          />
          <Field
            label="Seconds Between Rounds"
            mode="numeric"
            value={draft.min_seconds_between_rounds}
            onChange={set('min_seconds_between_rounds')}
          />
          <Toggle
            label="Purchased Diamonds Only"
            hint="Promotional And Earned Diamonds Cannot Be Played Into Chips."
            on={draft.purchased_only}
            onToggle={() => setDraft((d) => ({ ...d, purchased_only: !d.purchased_only }))}
          />
          <Toggle
            label="Allow Certification Accounts"
            hint="For Burn-In Only. Their Rounds Are Kept Out Of The Fairness Statistics."
            on={draft.allow_fixture_accounts}
            onToggle={() =>
              setDraft((d) => ({ ...d, allow_fixture_accounts: !d.allow_fixture_accounts }))
            }
          />
        </div>
      </SpadeConsole>

      <SpadeConsole
        eyebrow="Lifetime"
        title="The Pool"
        plates={{
          secondary: {
            label: 'Wheel Console',
            onClick: () => navigate(`/clubs/${routeClubId}/wheel-operations`),
          },
          primary: {
            label: `Players ${word}`,
            ink: 'white',
            /* Both targets spelled out. `/clubs/${id}/${game}` resolves at
               runtime, but check-route-targets reads the source, not the
               runtime, and a template it cannot resolve reads as a navigation
               to a route nobody declared. The two literals are what the gate
               is entitled to see, and the allowlist is for paths this router
               does not own, which these are not. */
            onClick: () =>
              navigate(
                game === 'plinko' ? `/clubs/${routeClubId}/plinko` : `/clubs/${routeClubId}/crash`
              ),
          },
        }}
      >
        <div className={`${styles.rows} ${styles.rowsCompact}`}>
          <Row label="Rounds" value={compactChips(pool?.rounds ?? 0)} />
          <Row
            label="Diamonds Taken In"
            value={compactChips(pool?.intake_diamonds ?? 0)}
            ink="blue"
          />
          <Row
            label="Chips Taken In"
            value={chips(metrics?.intake_chips)}
            meta="At The Bridge Rate"
          />
          <Row label="Chips Paid To Players" value={chips(pool?.chips_paid)} ink="gold" />
          <Row label="Chips Held For Open Rounds" value={chips(pool?.reserved_chips)} />
          <Row label="Capped Rounds" value={compactChips(pool?.constrained_rounds ?? 0)} />
        </div>
      </SpadeConsole>
    </div>
  );
}
