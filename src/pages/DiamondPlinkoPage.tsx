import { useLiveBonusGuard } from '../hooks/useLiveBonusGuard';
import { pendingBonus } from '../services/diamondBonusRecovery';
import { useBonusBudget } from '../hooks/useBonusBudget';
import { useEarnedBonus } from '../hooks/useEarnedBonus';
import DiamondSpinsTabs from '../components/games/DiamondSpinsTabs';
import BonusCompletion from '../components/games/BonusCompletion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { GameConsole, GamePanel } from '../components/games/GameConsole';
import BonusSetup, { bonusEntryStep, guaranteeCopy } from '../components/games/BonusSetup';
import TodayLine from '../components/games/TodayLine';
import { useGameCooldown } from '../hooks/useGameCooldown';
import PlinkoBoard from '../components/plinko/PlinkoBoard';
import { useMeasuredWidth } from '../hooks/useMeasuredWidth';
import DiamondGamesService, { type GameState } from '../services/DiamondGamesService';
import {
  DiamondBonusService,
  BonusRefusal,
  parsePlinkoBonus,
  type PlinkoBonus,
} from '../services/DiamondBonusService';
import {
  PLINKO_MAX_DROPS,
  bonusTotal,
  earnedReceiptBudget,
  bonusWalletDebit,
  gameChips,
  plinkoDrops,
  validBonusBudget,
  validPlinkoBudget,
} from '../utils/bonusGameBudget';
import {
  PLINKO_TABLES,
  diamondBonusMinimum,
  plinkoTableVersion,
} from '../utils/diamondBonusPayout';
import { diamondGameTitle } from '../utils/diamondGameTitles';
import { randomClientSeed, hmacSha256Hex, sha256Hex } from '../utils/wheelFairness';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { multiplierLabel } from '../utils/diamondGamesFairness';
import { roundedMinePrize } from '../utils/diamondChoiceMath';
import styles from './diamondGames.module.css';
import plinkoStyles from './diamondPlinko.module.css';

export default function DiamondPlinkoPage() {
  const { user } = useAuthUser();
  const { clubId } = useParams();
  return <DiamondPlinkoGame key={`${user?.id ?? ''}:${clubId ?? ''}`} />;
}
function DiamondPlinkoGame() {
  const { clubId } = useParams();
  const { user } = useAuthUser();
  const navigate = useNavigate();
  const [uuid, setUuid] = useState<string | null>(null);
  const [legacyState, setState] = useState<GameState | null>(null);
  const [quotedAmount, setQuotedAmount] = useState<number | null>(null);
  const [selectedBudget, setBudget, offer] = useBonusBudget(clubId, 'plinko');
  const earned = useEarnedBonus(uuid, 'plinko', selectedBudget);
  const budget = earned.budget;
  // Screen one of a won game is the Double Your Diamonds decision; screen two is
  // the drop selector; only the player's tap on Drop Diamonds starts play (R9).
  const offerAnswered = budget.award ? offer.answered(budget.award.id) : true;
  const step = bonusEntryStep(budget, offerAnswered);
  const state = (earned.gameState as GameState | null) ?? legacyState;
  const [ticket, setTicket] = useState<{ id: string; hash: string } | null>(null);
  const [seed, setSeed] = useState(randomClientSeed);
  const [result, setResult] = useState<PlinkoBonus | null>(null);
  const [completionId, setCompletionId] = useState<string | null>(null);
  const [landed, setLanded] = useState(0);
  /** How many of the sealed drops the player has released onto the board. */
  const [released, setReleased] = useState(0);
  /** A sealed batch is still coming down until every one of its drops has landed. */
  const animating = result !== null && landed < result.drops.length;
  const allReleased = result !== null && released >= result.drops.length;
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [waitSeconds, setWaitSeconds] = useGameCooldown();
  const live = useRef(true),
    busyRef = useRef(false),
    generation = useRef(0);
  const held = useRef<Parameters<typeof DiamondBonusService.start>[0] | null>(null);
  const [stageRef, width] = useMeasuredWidth<HTMLDivElement>(300);
  const total = bonusTotal(budget);
  const chosenDrops = plinkoDrops(budget);
  const receiptBudget = result
    ? earnedReceiptBudget(result as unknown as Record<string, unknown>)
    : null;
  const award = result ? receiptBudget?.award : budget.award;
  const boost = award?.boostMultiplier === 2 ? 2 : 1;
  const isSuper = boost === 2;
  const player = state?.player;
  const quotedBet = state?.bets.find((bet) => bet.bet_diamonds === total);
  // One table per stake kind, named by the server's own quote. Nobody chooses it,
  // and an award that cannot cover its table is not playable at this entry.
  const wantedVersion = earned.quote?.plinkoTable ?? plinkoTableVersion(boost);
  const table = (state?.tables ?? []).find(
    (option) =>
      option.version === wantedVersion &&
      (!quotedBet || (quotedBet.playable && quotedBet.cap_cents >= option.max_multiplier_cents))
  );
  const paths = useMemo(
    () => result?.drops.slice(0, released).map((ball) => ball.path_bits) ?? null,
    [result, released]
  );
  const painted =
    result && animating
      ? result.multipliers_cents
      : (table?.multipliers_cents ??
        result?.multipliers_cents ??
        PLINKO_TABLES[wantedVersion]?.multipliersCents ??
        []);
  const blocked =
    !earned.ready ||
    step !== 'setup' ||
    !validPlinkoBudget(budget) ||
    (!earned.award && quotedAmount !== total) ||
    !state?.available ||
    state.frozen ||
    !state.player?.is_member ||
    state.player.spendable < bonusWalletDebit(budget) ||
    !table ||
    state.player.rounds_today >= (state.config?.max_rounds_per_player_per_day ?? 0) ||
    waitSeconds > 0;
  /** The chips this game pays whatever the drops do, shown before Start. */
  const guaranteedChips = (() => {
    if (result) return result.minimum_payout_chips ?? 0;
    if (earned.quote) return earned.quote.minimumPayoutChips;
    const rate = state?.config?.diamonds_per_chip;
    if (earned.award || earned.loading || !rate) return null;
    try {
      return diamondBonusMinimum(total / rate, 1);
    } catch {
      return null;
    }
  })();

  const newTicket = useCallback(async () => {
    const next = await DiamondGamesService.commit('plinko');
    if (
      !next.ok ||
      !/^[a-f0-9]{64}$/.test(next.server_seed_hash) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(next.commit_id)
    )
      throw new Error(next.error ?? 'The Ticket Could Not Be Loaded');
    if (live.current) setTicket({ id: next.commit_id, hash: next.server_seed_hash });
  }, []);
  const load = useCallback(
    async (id: string, amount: number) => {
      const g = ++generation.current;
      setQuotedAmount(null);
      const next = await DiamondGamesService.getState(id, 'plinko', Math.min(amount, 5000));
      if (live.current && g === generation.current) {
        setState(next);
        setQuotedAmount(amount);
        setWaitSeconds(next.player?.seconds_until_next ?? 0);
      }
    },
    [setWaitSeconds]
  );
  useEffect(() => {
    live.current = true;
    let cancelled = false;
    (async () => {
      if (!clubId) return;
      try {
        const id = await resolveClubUUID(clubId);
        if (cancelled) return;
        setUuid(id);
        const pending = pendingBonus(user?.id ?? '', id, 'plinko');
        if (pending) {
          held.current = pending;
          setBudget(pending.budget);
          setUncertain(true);
          setTicket(null);
          setError('Check Your Saved Bonus Before Starting Another.');
          return;
        }
        await newTicket();
      } catch (e) {
        reportError(e, 'DiamondPlinkoPage.load');
        if (!cancelled) setError('Plinko Could Not Be Loaded. Try Refresh.');
      }
    })();
    return () => {
      cancelled = true;
      live.current = false;
      generation.current++;
    };
  }, [clubId, user?.id, newTicket, setBudget]);
  useEffect(() => {
    if (!uuid || !validBonusBudget(budget) || earned.loading || earned.required) return;
    void load(uuid, total).catch((e) => {
      reportError(e, 'DiamondPlinkoPage.quote');
      if (live.current) setError('The Entry Could Not Be Checked. Try Refresh.');
    });
  }, [uuid, total, budget.base, earned.loading, earned.required, load]);
  useEffect(() => {
    if (earned.gameState)
      setWaitSeconds((earned.gameState as GameState).player?.seconds_until_next ?? 0);
  }, [earned.gameState, setWaitSeconds]);

  useEffect(() => {
    if (!earned.recoveredResult || result || animating || uncertain) return;
    try {
      const saved = parsePlinkoBonus(earned.recoveredResult);
      setResult(saved);
      setReleased(saved.drops.length);
      setLanded(saved.drops.length);
      setCompletionId(saved.id);
    } catch (error) {
      reportError(error, 'DiamondPlinkoPage.awardRecovery');
      setError('Your Saved Wheel Bonus Could Not Be Verified.');
    }
  }, [earned.recoveredResult, result, animating, uncertain]);

  /** The tap on Drop Diamonds is the first drop; each further ball is the player's own release. */
  const accept = (next: PlinkoBonus, animate: boolean) => {
    earned.consume(next.award_id);
    setResult(next);
    setCompletionId(next.id);
    setLanded(animate ? 0 : next.drops.length);
    setReleased(animate ? Math.min(1, next.drops.length) : next.drops.length);
    held.current = null;
    setUncertain(false);
    setTicket(null);
    setError(null);
    if (uuid && !earned.required)
      void load(uuid, total).catch((e) => reportError(e, 'DiamondPlinkoPage.after'));
  };
  const play = async () => {
    if (!uuid || !ticket || busyRef.current || blocked || animating || uncertain) return;
    busyRef.current = true;
    generation.current++;
    setQuotedAmount(null);
    setBusy(true);
    setError(null);
    setVerified(null);
    const request = {
      clubId: uuid,
      game: 'plinko' as const,
      budget: { ...budget },
      commitId: ticket.id,
      serverSeedHash: ticket.hash,
      seed,
      tableVersion: table!.version,
    };
    held.current = request;
    try {
      const next = parsePlinkoBonus(await DiamondBonusService.start(request, user?.id ?? ''));
      if (live.current) accept(next, true);
    } catch (e) {
      reportError(e, 'DiamondPlinkoPage.start');
      if (live.current) {
        setUncertain(!(e instanceof BonusRefusal));
        setError(
          e instanceof BonusRefusal ? e.message : 'Check Your Bonus Before Starting Another.'
        );
      }
    } finally {
      busyRef.current = false;
      if (live.current) setBusy(false);
    }
  };
  const check = async () => {
    if (!uuid || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (held.current && uncertain) {
        const next = parsePlinkoBonus(
          await DiamondBonusService.start(held.current, user?.id ?? '')
        );
        if (!live.current) return;
        accept(next, false);
      }
      if (!live.current) return;
      await earned.refresh();
      if (!earned.required) await load(uuid, validBonusBudget(budget) ? total : 100);
      if (!live.current) return;
      if (!ticket || uncertain) await newTicket();
      if (live.current) setError(null);
    } catch (e) {
      reportError(e, 'DiamondPlinkoPage.check');
      if (live.current) {
        setError(
          e instanceof BonusRefusal ? e.message : 'Your Bonus Could Not Be Checked. Try Again.'
        );
        if (e instanceof BonusRefusal) {
          held.current = null;
          setUncertain(false);
        }
      }
    } finally {
      busyRef.current = false;
      if (live.current) setBusy(false);
    }
  };
  /** Every released drop has landed. With drops still in hand, the board waits for the player. */
  const landedAll = () => {
    if (!result || released < result.drops.length) return;
    setLanded(result.drops.length);
    void newTicket().catch((e) => {
      reportError(e, 'DiamondPlinkoPage.ticket');
      if (live.current) setError('Refresh To Prepare Your Next Ticket.');
    });
  };
  /** The player's own release of the next ball, or of every ball still in hand. */
  const release = (all: boolean) => {
    if (!result || allReleased) return;
    setReleased(all ? result.drops.length : Math.min(result.drops.length, released + 1));
  };
  /** Show Results: the player skips the rest of a batch already fully released. */
  const showResults = () => {
    if (!result || !allReleased) return;
    setLanded(result.drops.length);
    landedAll();
  };
  const verify = async () => {
    if (!result || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      let matches = (await sha256Hex(result.server_seed)) === result.server_seed_hash;
      for (const ball of result.drops) {
        if (!live.current) return;
        const hash = await hmacSha256Hex(
          result.server_seed,
          `${result.client_seed}:${result.nonce}:drop:${ball.index}`
        );
        const bits =
          Number.parseInt(hash.slice(0, 2), 16) | (Number.parseInt(hash.slice(2, 4), 16) << 8);
        let slot = 0;
        for (let i = 0; i < 16; i++) slot += (bits >> i) & 1;
        const rounding = await hmacSha256Hex(
          result.server_seed,
          `${result.client_seed}:${result.nonce}:rounding:${ball.index}`
        );
        const cents = roundedMinePrize(
          BigInt(result.diamonds_per_drop * ball.multiplier_cents),
          BigInt(result.diamonds_per_chip),
          BigInt(`0x${rounding.slice(0, 12)}`)
        );
        if (
          bits !== ball.path_bits ||
          slot !== ball.slot ||
          Number(cents) !== Math.round(ball.payout_chips * 100)
        ) {
          matches = false;
          break;
        }
      }
      if (live.current) setVerified(matches);
    } catch (e) {
      reportError(e, 'DiamondPlinkoPage.verify');
      if (live.current) setVerified(false);
    } finally {
      busyRef.current = false;
      if (live.current) setBusy(false);
    }
  };
  useLiveBonusGuard(Boolean(earned.award) || busy || uncertain || animating, () =>
    setError('Finish Your Bonus Game Before Leaving.')
  );
  const droppedChips = result
    ? result.drops
        .slice(0, landed)
        .reduce((sum, ball) => sum + Math.round(ball.payout_chips * 100), 0) / 100
    : 0;
  // Every drop has landed, so the booked figure is the receipt: a Super batch
  // whose drops fell short is topped up to its guarantee, and that is what paid.
  const settled = Boolean(result) && landed >= (result?.drops.length ?? 0) && !animating;
  const shownWin = settled ? (result?.payout_chips ?? 0) : droppedChips;
  const toppedUp = Boolean(
    result && settled && Math.round(result.payout_chips * 100) > Math.round(droppedChips * 100)
  );
  return (
    <div className={`${styles.page} ${styles.fullscreenPage}`}>
      <button className={styles.back} onClick={() => navigate(`/clubs/${clubId}/diamond-games`)}>
        ‹ Diamond Spins
      </button>
      <DiamondSpinsTabs clubId={clubId ?? ''} />
      <GameConsole
        setup={
          !animating && (
            <BonusSetup
              budget={budget}
              entryReady={earned.ready}
              awardLoading={earned.loading}
              awardError={earned.error}
              onRefresh={() => void earned.refresh()}
              onChange={setBudget}
              diamonds={state?.player?.spendable ?? null}
              disabled={busy || uncertain}
              game="plinko"
              guarantee={earned.quote}
              clubId={clubId ?? ''}
              offerAnswered={offerAnswered}
              onOfferAnswered={offer.answer}
            />
          )
        }
        title={diamondGameTitle('plinko', boost)}
        eyebrow="Diamond Spins"
        pill={
          uncertain
            ? 'Check Bonus'
            : animating
              ? 'Dropping'
              : completionId
                ? 'Completed'
                : step === 'offer'
                  ? 'Your Choice'
                  : 'Ready'
        }
        bays={[
          {
            label: 'Per Drop',
            value: animating
              ? (result?.diamonds_per_drop ?? 0).toLocaleString()
              : budget.denomination === null
                ? 'Choose'
                : budget.denomination.toLocaleString(),
          },
          {
            label: 'Drops',
            value:
              animating && result
                ? `${landed}/${result.drops.length}`
                : chosenDrops === null
                  ? 'Choose'
                  : chosenDrops.toLocaleString(),
          },
          {
            label: 'Guaranteed',
            value: guaranteedChips === null ? 'Pending' : `${gameChips(guaranteedChips)} Chips`,
            ink: isSuper ? 'gold' : undefined,
          },
          { label: 'Chip Prize', value: gameChips(shownWin), ink: 'gold' },
        ]}
        secondary={{
          label: uncertain
            ? 'Check Bonus'
            : animating
              ? allReleased
                ? 'Show Results'
                : 'Drop All'
              : 'Refresh',
          onClick: () => (animating ? (allReleased ? showResults() : release(true)) : void check()),
          disabled: busy,
        }}
        primary={
          animating
            ? {
                label: allReleased
                  ? 'Dropping'
                  : `Drop ${(released + 1).toLocaleString()} Of ${(result?.drops.length ?? 0).toLocaleString()}`,
                onClick: () => release(false),
                disabled: allReleased,
              }
            : {
                label:
                  waitSeconds > 0
                    ? `Ready In ${waitSeconds}s`
                    : step === 'offer'
                      ? 'Answer The Offer First'
                      : 'Drop Diamonds',
                onClick: () => void play(),
                disabled: busy || uncertain || blocked || !ticket,
              }
        }
      >
        <TodayLine
          used={player?.rounds_today ?? 0}
          cap={state?.config?.max_rounds_per_player_per_day ?? 0}
          spentDiamonds={player?.diamonds_today ?? 0}
          noun="Rounds"
        />
        <div ref={stageRef}>
          <PlinkoBoard
            width={Math.max(240, Math.min(680, width))}
            multipliersCents={painted}
            path={null}
            dropKey={result ? Number.parseInt(result.id.slice(0, 8), 16) : 0}
            batchPathBits={animating ? paths : null}
            onProgress={setLanded}
            onLanded={landedAll}
            restingSlot={
              result?.table_version === table?.version
                ? (result?.drops[Math.max(0, landed - 1)]?.slot ?? null)
                : null
            }
          />
        </div>
        <p className="sc-copy" role="status">
          {error ??
            (animating
              ? allReleased
                ? 'Every Drop Follows Your Saved Result.'
                : `${(result!.drops.length - released).toLocaleString()} ${result!.drops.length - released === 1 ? 'Drop' : 'Drops'} In Hand. Tap Drop For The Next Diamond, Or Drop All.`
              : result
                ? `${gameChips(result.payout_chips)} Chips Booked From ${result.drops.length} Drops.${toppedUp ? ` Your Guarantee Of ${gameChips(result.minimum_payout_chips ?? 0)} Chips Topped Up The Drops.` : ''}`
                : step === 'offer'
                  ? 'Decide Whether To Double Your Diamonds, Then Choose Your Drops.'
                  : ((earned.quote && guaranteeCopy('plinko', earned.quote)) ??
                    'Choose Your Diamonds Per Drop. Start Your Bonus When You Are Ready.'))}
        </p>
        {!animating && blocked && state && (
          <p className="sc-copy">
            {!earned.ready
              ? (earned.error ??
                (earned.loading
                  ? 'Checking Your Wheel Award'
                  : 'Win Plinko On Diamond Spins To Play.'))
              : state.frozen
                ? 'Games Are Paused For Maintenance. Refresh After The Break.'
                : !state.available
                  ? 'Plinko Is Not Open Here Yet.'
                  : !state.player?.is_member
                    ? 'Join The Club To Play.'
                    : state.player.spendable < bonusWalletDebit(budget)
                      ? budget.award
                        ? 'Buy More Diamonds Or Turn Off Double Down.'
                        : 'Buy More Diamonds Or Change Your Entry.'
                      : step === 'offer'
                        ? 'Answer The Double Your Diamonds Offer To Continue.'
                        : !validPlinkoBudget(budget)
                          ? `Choose Your Diamonds Per Drop. Every Value Divides Your ${bonusTotal(budget).toLocaleString()} Diamonds Into 1 To ${PLINKO_MAX_DROPS} Drops.`
                          : !table
                            ? budget.doubled
                              ? 'This Bonus Does Not Cover A Doubled Entry. Choose Keep My Bonus To Play.'
                              : 'The Plinko Table Is Not Open For This Entry. Refresh Or Return To The Wheel.'
                            : waitSeconds > 0
                              ? `Your Next Drop Is Ready In ${waitSeconds} Seconds.`
                              : 'Refresh To Check This Entry And The Available Prize Cover.'}
          </p>
        )}
      </GameConsole>
      <GamePanel title="How To Play" pill="Rules" foot="foot">
        <p className="sc-copy">
          You Choose How Many Diamonds Each Drop Plays, From 1 To {PLINKO_MAX_DROPS} Drops Of Your
          Entry. Every Diamond Lands In A Prize Slot, And Your Chips Are Booked When The Last Drop
          Lands. Tap Drop For Each Diamond, Or Drop All To Release The Rest.
        </p>
        <p className="sc-copy">
          One Table For Every Game. Nobody Picks A Risk Level; It Is Built Into The Payout. The
          Outer Slots Pay Up To {multiplierLabel(2000)}, And The Middle Slots Pay The Least. Fewer,
          Bigger Drops Swing Further; More, Smaller Drops Land Closer To The Average.
        </p>
        {table && (
          <p className="sc-copy">
            This Game Plays The {table.name} Table, Top Prize{' '}
            {multiplierLabel(table.max_multiplier_cents)} Per Drop.
            {isSuper
              ? ' Every Super Slot Pays, So Your Drops Return At Least Your Original Spin.'
              : ''}
          </p>
        )}
      </GamePanel>
      <GamePanel
        title="Bonus Proof"
        pill={verified === true ? 'Verified' : 'Sealed'}
        eyebrow="Sealed Before Play"
        foot="foot"
      >
        <p className={`sc-copy ${styles.proofHash}`}>
          {ticket?.hash ?? result?.server_seed_hash ?? 'Preparing Your Ticket'}
        </p>
        <label className={styles.seedField}>
          Your Seed
          <input
            className={styles.seedInput}
            value={seed}
            maxLength={64}
            disabled={busy || animating || uncertain}
            onChange={(e) => setSeed(e.target.value)}
          />
        </label>
        {result && !animating && (
          <p className={`sc-copy ${styles.proofHash}`}>
            Completed Bonus: {result.server_seed_hash}
          </p>
        )}
        {result && !animating && (
          <button className={styles.back} disabled={busy} onClick={() => void verify()}>
            Verify Every Drop
          </button>
        )}
        {verified !== null && (
          <p className="sc-copy">
            {verified
              ? 'Every Drop And Chip Prize Matches The Sealed Bonus.'
              : 'The Bonus Could Not Be Verified.'}
          </p>
        )}
      </GamePanel>
      {result && !animating && (
        <GamePanel title="Your Results" pill={`${result.drops.length} Drops`} foot="foot">
          {result.multipliers_cents.map((mult, slot) => {
            const balls = result.drops.filter((b) => b.slot === slot);
            return balls.length ? (
              <div className={styles.row} key={slot}>
                <span className="sc-label">
                  {balls.length} At {multiplierLabel(mult)}
                </span>
                <span>{gameChips(balls.reduce((sum, b) => sum + b.payout_chips, 0))} Chips</span>
              </div>
            ) : null;
          })}
          {toppedUp && (
            <div className={`${styles.row} ${plinkoStyles.guaranteeRow}`}>
              <span className="sc-label">Your Super Guarantee</span>
              <span>{gameChips(result.payout_chips)} Chips Booked</span>
            </div>
          )}
        </GamePanel>
      )}
      {result && completionId === result.id && !animating && !uncertain && !busy && (
        <BonusCompletion
          key={result.id}
          clubId={clubId ?? ''}
          clubUuid={uuid}
          awardId={result.award_id ?? null}
          chips={result.payout_chips}
          detail={`${result.drops.length} Drops Completed.`}
        />
      )}
    </div>
  );
}
