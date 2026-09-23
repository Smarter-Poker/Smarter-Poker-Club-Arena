import { useLiveBonusGuard } from '../hooks/useLiveBonusGuard';
import { pendingBonus, PriorBonusPending } from '../services/diamondBonusRecovery';
import { useAutoSettle, useStandingRefresh } from '../hooks/useAutoSettle';
import { useAwardAutoStart, useRefusedAward } from '../hooks/useAwardAutoStart';
import { useBonusBudget } from '../hooks/useBonusBudget';
import { useEarnedBonus } from '../hooks/useEarnedBonus';
import DiamondSpinsTabs from '../components/games/DiamondSpinsTabs';
import BonusCompletion from '../components/games/BonusCompletion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { GameConsole, GamePanel } from '../components/games/GameConsole';
import BonusSetup, { guaranteeCopy } from '../components/games/BonusSetup';
import TodayLine from '../components/games/TodayLine';
import { useGameCooldown } from '../hooks/useGameCooldown';
import PlinkoBoard from '../components/plinko/PlinkoBoard';
import { useMeasuredWidth } from '../hooks/useMeasuredWidth';
import DiamondGamesService, { type GameState } from '../services/DiamondGamesService';
import {
  DiamondBonusService,
  BonusRefusal,
  BonusUnreadable,
  BONUS_SAVED,
  parsePlinkoBonus,
  type BonusStart,
  type PlinkoBonus,
} from '../services/DiamondBonusService';
import {
  PLINKO_DROPS,
  bonusTotal,
  earnedReceiptBudget,
  bonusWalletDebit,
  gameChips,
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

/** What the page says while it mends something by itself. */
const RECONNECTING = 'Reconnecting To Plinko';
const CHECKING_ENTRY = 'Checking Your Entry';
const PREPARING_TICKET = 'Preparing Your Ticket';
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
  const [selectedBudget, setBudget] = useBonusBudget(clubId, 'plinko');
  const earned = useEarnedBonus(uuid, 'plinko', selectedBudget);
  const budget = earned.budget;
  const state = (earned.gameState as GameState | null) ?? legacyState;
  const [ticket, setTicket] = useState<{ id: string; hash: string } | null>(null);
  const [seed, setSeed] = useState(randomClientSeed);
  const [result, setResult] = useState<PlinkoBonus | null>(null);
  const [completionId, setCompletionId] = useState<string | null>(null);
  const [landed, setLanded] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [busy, setBusy] = useState(false);
  // A wager whose answer never arrived. The page settles it on its own
  // schedule (useAutoSettle); the player is never asked to check anything.
  const [uncertain, setUncertain] = useState(false);
  const [settleAttempts, setSettleAttempts] = useState(0);
  // The server answered the saved wager BONUS_SENDS_PER_REQUEST times and this
  // browser could verify none of the answers. It stays saved (money may have
  // moved) and is sent again on the next visit; on this one nothing more is
  // sent for it and nothing holds the player.
  const [saved, setSaved] = useState(false);
  // The server refused a ticket that could no longer open a batch and charged
  // nothing, so the same wager goes again on a fresh ticket - once per press.
  const [restartOwed, setRestartOwed] = useState(false);
  // The Double Down offer is a question about the player's own diamonds. A won
  // game never starts itself over it; it is treated as open until the setup
  // panel says otherwise.
  const [offerOpen, setOfferOpen] = useState(true);
  // A read or a ticket deal that failed is tried again by the page itself,
  // on the same schedule as a saved wager. Nobody is told to refresh.
  const [loadFailures, setLoadFailures] = useState(0);
  const [loadTry, setLoadTry] = useState(0);
  const [quoteFailures, setQuoteFailures] = useState(0);
  const [quoteTry, setQuoteTry] = useState(0);
  const [ticketFailures, setTicketFailures] = useState(0);
  const [ticketTry, setTicketTry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [waitSeconds, setWaitSeconds] = useGameCooldown();
  const live = useRef(true),
    busyRef = useRef(false),
    generation = useRef(0);
  const held = useRef<BonusStart | null>(null);
  // The exact wager the server refused for its ticket alone. It goes again,
  // unchanged but for the fresh ticket: never rebuilt from what the page
  // happens to show by then (another award, another Double Down answer).
  const owed = useRef<BonusStart | null>(null);
  const [stageRef, width] = useMeasuredWidth<HTMLDivElement>(300);
  const total = bonusTotal(budget);
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
  const paths = useMemo(() => result?.drops.map((ball) => ball.path_bits) ?? null, [result]);
  const painted =
    result && animating
      ? result.multipliers_cents
      : (table?.multipliers_cents ??
        result?.multipliers_cents ??
        PLINKO_TABLES[wantedVersion]?.multipliersCents ??
        []);
  // What the server's own state says about dropping now. Deliberately without
  // the entry quote, which blinks off during every drop and must not count as
  // the server changing its mind.
  const stateBlocked =
    !earned.ready ||
    !validPlinkoBudget(budget) ||
    !state?.available ||
    state.frozen ||
    !state.player?.is_member ||
    state.player.spendable < bonusWalletDebit(budget) ||
    !table ||
    state.player.rounds_today >= (state.config?.max_rounds_per_player_per_day ?? 0) ||
    waitSeconds > 0;
  const blocked = stateBlocked || (!earned.award && quotedAmount !== total);
  const refusal = useRefusedAward(earned.award?.id, stateBlocked);
  /** One place decides what a refusal means; the drop and the replay both land here. */
  const settleRefusal = (e: BonusRefusal, refused: BonusStart | null) => {
    if (e.ticketGone && refused) {
      // Only the ticket was refused and nothing was charged: the same wager
      // goes again on a fresh ticket, by itself.
      owed.current = refused;
      setRestartOwed(true);
      return;
    }
    // Anything else: read the award again so the page shows why, and let go of
    // the player until the server's reasons change.
    refusal.refuse(refused?.budget.award?.id);
    void earned.refresh();
  };
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
    if (live.current) {
      setTicket({ id: next.commit_id, hash: next.server_seed_hash });
      // A fresh player seed for every ticket, chosen after its hash is on
      // screen, so no dealt seed can have been picked knowing the player's
      // (fairness audit 2026-09-21). An owed wager keeps its own seed.
      if (!owed.current) setSeed(randomClientSeed());
    }
  }, []);
  /** Reads the game and quotes the entry. Every read clears the quote before
   * it asks, so the latest read owns the quote, whoever made it (the quote's
   * own effect, the read after a drop, a replay): its answer is the quote, and
   * its failure is counted here and read again on the quote's schedule below.
   * A read overtaken by a newer one counts for nothing. */
  const load = useCallback(
    async (id: string, amount: number) => {
      const g = ++generation.current;
      setQuotedAmount(null);
      let next: GameState;
      try {
        next = await DiamondGamesService.getState(id, 'plinko', Math.min(amount, 5000));
      } catch (error) {
        if (live.current && g === generation.current) setQuoteFailures((count) => count + 1);
        throw error;
      }
      if (live.current && g === generation.current) {
        setState(next);
        setQuotedAmount(amount);
        setQuoteFailures(0);
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
          // Replayed by useAutoSettle; a ticket follows once it is settled.
          held.current = pending;
          setBudget(pending.budget);
          setSeed(pending.seed);
          setUncertain(true);
          setTicket(null);
        }
        // The ticket is dealt by its own effect once the club is known.
        setLoadFailures(0);
        setError((current) => (current === RECONNECTING ? null : current));
      } catch (e) {
        reportError(e, 'DiamondPlinkoPage.load');
        if (!cancelled) {
          setError(RECONNECTING);
          setLoadFailures((count) => count + 1);
        }
      }
    })();
    return () => {
      cancelled = true;
      live.current = false;
      generation.current++;
    };
  }, [clubId, user?.id, setBudget, loadTry]);
  useAutoSettle(loadFailures > 0, loadFailures, async () => {
    setLoadTry((count) => count + 1);
    return true;
  });
  useEffect(() => {
    if (!uuid || !validBonusBudget(budget) || earned.loading || earned.required) return;
    let cancelled = false;
    // A failure is counted by load itself, whichever read it was.
    load(uuid, total)
      .then(() => {
        if (cancelled || !live.current) return;
        setError((current) => (current === CHECKING_ENTRY ? null : current));
      })
      .catch((e) => {
        reportError(e, 'DiamondPlinkoPage.quote');
        if (cancelled || !live.current) return;
        setError(CHECKING_ENTRY);
      });
    return () => {
      cancelled = true;
    };
  }, [uuid, total, budget.base, earned.loading, earned.required, load, quoteTry]);
  useAutoSettle(quoteFailures > 0, quoteFailures, async () => {
    setQuoteTry((count) => count + 1);
    return true;
  });
  useEffect(() => {
    if (earned.gameState)
      setWaitSeconds((earned.gameState as GameState).player?.seconds_until_next ?? 0);
  }, [earned.gameState, setWaitSeconds]);

  useEffect(() => {
    if (!earned.recoveredResult || result || animating || uncertain) return;
    try {
      const saved = parsePlinkoBonus(earned.recoveredResult);
      setResult(saved);
      setLanded(saved.drops.length);
      setCompletionId(saved.id);
    } catch (error) {
      reportError(error, 'DiamondPlinkoPage.awardRecovery');
      setError('Your Saved Wheel Bonus Could Not Be Verified.');
    }
  }, [earned.recoveredResult, result, animating, uncertain]);

  const accept = (next: PlinkoBonus, animate: boolean) => {
    earned.consume(next.award_id);
    setResult(next);
    setCompletionId(next.id);
    setLanded(animate ? 0 : next.drops.length);
    setAnimating(animate);
    held.current = null;
    setUncertain(false);
    setTicket(null);
    setError(null);
    if (uuid && !earned.required)
      void load(uuid, total).catch((e) => reportError(e, 'DiamondPlinkoPage.after'));
  };
  /** Stop sending a saved wager whose answers will not verify, let the player
   * go, and read the game again. */
  const keepForNextVisit = (id: string) => {
    setSaved(true);
    setError(BONUS_SAVED);
    void earned.refresh();
    if (!earned.required)
      void load(id, validBonusBudget(budget) ? total : 100).catch((readError) =>
        reportError(readError, 'DiamondPlinkoPage.saved')
      );
  };
  /** Drops the batch the page shows, or - given `resend` - re-sends exactly the
   * wager the server refused for its ticket, on the ticket now in hand. */
  const play = async (resend?: BonusStart) => {
    if (!uuid || !ticket || busyRef.current || (!resend && blocked) || animating || uncertain)
      return;
    busyRef.current = true;
    generation.current++;
    setQuotedAmount(null);
    setBusy(true);
    setError(null);
    setVerified(null);
    // An emptied "Your Seed" is not a decision the player made about this
    // batch: the service refuses a blank seed before anything is sent, and
    // that refusal reads to the page exactly like the server's own. The page
    // deals itself a seed instead, and shows the one the drops were sent with,
    // so Bonus Proof still names what was actually used. A resend keeps its
    // own seed, because it is the same wager going again.
    const sent = seed.trim() ? seed : randomClientSeed();
    if (!resend && sent !== seed) setSeed(sent);
    const request: BonusStart = resend
      ? { ...resend, commitId: ticket.id, serverSeedHash: ticket.hash }
      : {
          clubId: uuid,
          game: 'plinko' as const,
          budget: { ...budget },
          commitId: ticket.id,
          serverSeedHash: ticket.hash,
          seed: sent,
          tableVersion: table!.version,
        };
    held.current = request;
    try {
      const next = parsePlinkoBonus(await DiamondBonusService.start(request, user?.id ?? ''));
      if (live.current) accept(next, true);
    } catch (e) {
      reportError(e, 'DiamondPlinkoPage.start');
      if (live.current) {
        if (e instanceof PriorBonusPending) {
          // Another tab's wager is still saved: it settles first, by itself.
          held.current = e.prior;
          setBudget(e.prior.budget);
          setUncertain(true);
          setSettleAttempts(0);
          setError('Settling Your Previous Bonus First');
        } else if (e instanceof BonusRefusal) {
          // Nothing was charged. The ticket is spent either way, so a fresh
          // one is dealt; when the ticket itself was the refusal the same
          // wager is sent again on it.
          const refused = held.current;
          held.current = null;
          setUncertain(false);
          setTicket(null);
          setError(e.message);
          settleRefusal(e, refused);
          // This start cleared the entry quote. Read it again, so the next
          // drop is not held on it until someone refreshes.
          if (!earned.required) setQuoteTry((count) => count + 1);
        } else if (e instanceof BonusUnreadable && e.final) {
          setUncertain(true);
          keepForNextVisit(uuid);
        } else {
          // The answer never arrived. The saved wager is replayed by
          // useAutoSettle until the server says what happened.
          setUncertain(true);
          setSettleAttempts(0);
          setError('Settling Your Bonus');
        }
      }
    } finally {
      busyRef.current = false;
      if (live.current) setBusy(false);
    }
  };
  const check = async (): Promise<boolean> => {
    if (!uuid || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      if (held.current && uncertain) {
        const next = parsePlinkoBonus(
          await DiamondBonusService.start(held.current, user?.id ?? '')
        );
        if (!live.current) return true;
        accept(next, false);
      }
      if (!live.current) return true;
      await earned.refresh();
      if (!earned.required) await load(uuid, validBonusBudget(budget) ? total : 100);
      if (live.current) {
        setError(null);
        setSettleAttempts(0);
      }
    } catch (e) {
      reportError(e, 'DiamondPlinkoPage.check');
      if (live.current) {
        if (e instanceof BonusRefusal) {
          const refused = held.current;
          held.current = null;
          setUncertain(false);
          setSettleAttempts(0);
          setTicket(null);
          setError(e.message);
          settleRefusal(e, refused);
        } else if (e instanceof BonusUnreadable && e.final) {
          keepForNextVisit(uuid);
        } else if (held.current) {
          // Not an answer: the page tries again on its own schedule.
          setSettleAttempts((count) => count + 1);
          setError('Settling Your Bonus');
        } else {
          // The replay above answered and accept() let the wager go; what
          // failed is the entry read that follows it, which counts itself and
          // is read again on the quote's own schedule. Nothing is in flight,
          // so the page must not say it is settling over a booked receipt.
          setSettleAttempts(0);
          setError(CHECKING_ENTRY);
        }
      }
    } finally {
      busyRef.current = false;
      if (live.current) setBusy(false);
    }
    return true;
  };
  useAutoSettle(uncertain && !saved, settleAttempts, check);
  // A wager the server refused for its ticket alone is sent again on the
  // fresh ticket, once, without the player pressing Drop twice.
  const playRef = useRef(play);
  playRef.current = play;
  const restarts = useRef(0);
  useEffect(() => {
    // The owed wager is re-sent as it was; only the server decides whether it
    // can still start (a refusal now settles like any other).
    if (!restartOwed || !ticket || uncertain || busy || animating) return;
    setRestartOwed(false);
    const wager = owed.current;
    owed.current = null;
    if (!wager || restarts.current >= 2) return;
    restarts.current += 1;
    void playRef.current(wager);
  }, [restartOwed, ticket, uncertain, busy, animating]);
  // A won game starts itself: a short visible countdown, then the same drop
  // the button would have pressed.
  const autoStartIn = useAwardAutoStart(
    earned.award?.id,
    !uncertain &&
      !busy &&
      !animating &&
      !blocked &&
      Boolean(ticket) &&
      !restartOwed &&
      !offerOpen &&
      !result &&
      !refusal.refused,
    // Typing still restarts the five seconds; an empty field is typing too,
    // and play() deals the seed it sends.
    `${total}:${seed}:${refusal.opening}`,
    () => void playRef.current()
  );
  // Games paused by the platform come back by themselves after the break.
  useStandingRefresh(Boolean(state?.frozen) && !busy && !uncertain && !animating, () => {
    void earned.refresh();
    if (!earned.required) setQuoteTry((count) => count + 1);
  });
  // A refused ticket is replaced without a press.
  useEffect(() => {
    if (ticket || uncertain || animating || !uuid) return;
    let cancelled = false;
    newTicket()
      .then(() => {
        if (cancelled || !live.current) return;
        setTicketFailures(0);
        setError((current) => (current === PREPARING_TICKET ? null : current));
      })
      .catch((e) => {
        reportError(e, 'DiamondPlinkoPage.redeal');
        if (cancelled || !live.current) return;
        setError(PREPARING_TICKET);
        setTicketFailures((count) => count + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [ticket, uncertain, animating, uuid, newTicket, ticketTry]);
  useAutoSettle(ticketFailures > 0 && !ticket && !uncertain, ticketFailures, async () => {
    setTicketTry((count) => count + 1);
    return true;
  });
  const finish = () => {
    setAnimating(false);
    if (result) setLanded(result.drops.length);
    // The next ticket is dealt by its own effect once the drops have landed.
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
  // Money in flight holds the page. A won game holds it only while it can
  // actually start: an award this page cannot start (daily limit, a closed or
  // paused game, a cooldown) never traps the player on it.
  // A wager kept for the next visit has nothing in flight: it holds nothing.
  const releaseGuard = useLiveBonusGuard(
    !saved &&
      ((Boolean(earned.award) && !blocked && Boolean(ticket) && !result && !refusal.refused) ||
        busy ||
        uncertain ||
        animating),
    () => setError('Finish Your Bonus Game Before Leaving.')
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
              onChange={setBudget}
              onOffer={setOfferOpen}
              diamonds={state?.player?.spendable ?? null}
              disabled={busy || uncertain || restartOwed}
              game="plinko"
              guarantee={earned.quote}
              clubId={clubId ?? ''}
              leave={(to) => {
                if (busyRef.current) return;
                releaseGuard();
                navigate(to);
              }}
            />
          )
        }
        title={diamondGameTitle('plinko', boost)}
        eyebrow="Diamond Spins"
        pill={
          saved
            ? 'Saved'
            : uncertain
              ? 'Settling'
              : animating
                ? 'Dropping'
                : completionId
                  ? 'Completed'
                  : 'Ready'
        }
        bays={[
          {
            label: 'Per Drop',
            value: (
              (animating ? result?.diamonds_per_drop : budget.denomination) ?? 0
            ).toLocaleString(),
          },
          {
            label: 'Drops',
            value: animating && result ? `${landed}/${result.drops.length}` : String(PLINKO_DROPS),
          },
          {
            label: 'Guaranteed',
            value: guaranteedChips === null ? 'Pending' : `${gameChips(guaranteedChips)} Chips`,
            ink: isSuper ? 'gold' : undefined,
          },
          { label: 'Chip Prize', value: gameChips(shownWin), ink: 'gold' },
        ]}
        secondary={{
          label: animating ? 'Show Results' : 'Refresh',
          onClick: () => (animating ? finish() : void check()),
          disabled: busy || uncertain,
        }}
        primary={{
          label:
            waitSeconds > 0
              ? `Ready In ${waitSeconds}s`
              : autoStartIn !== null
                ? `Dropping In ${autoStartIn}s`
                : 'Drop Diamonds',
          onClick: () => void play(),
          disabled: busy || uncertain || animating || blocked || !ticket,
        }}
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
            onLanded={finish}
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
              ? 'Every Drop Follows Your Saved Result.'
              : result
                ? `${gameChips(result.payout_chips)} Chips Booked From ${result.drops.length} Drops.${toppedUp ? ` Your Guarantee Of ${gameChips(result.minimum_payout_chips ?? 0)} Chips Topped Up The Drops.` : ''}`
                : ((earned.quote && guaranteeCopy('plinko', earned.quote)) ??
                  `Your Entry Plays ${PLINKO_DROPS} Drops. Start Your Bonus When You Are Ready.`))}
        </p>
        {!animating && blocked && state && (
          <p className="sc-copy">
            {!earned.ready
              ? (earned.error ??
                (earned.loading
                  ? 'Checking Your Wheel Award'
                  : 'Win Plinko On Diamond Spins To Play.'))
              : state.frozen
                ? 'Games Are Paused For Maintenance. Play Resumes By Itself After The Break.'
                : !state.available
                  ? 'Plinko Is Not Open Here Yet.'
                  : !state.player?.is_member
                    ? 'Join The Club To Play.'
                    : state.player.spendable < bonusWalletDebit(budget)
                      ? budget.award
                        ? 'Buy More Diamonds Or Turn Off Double Down.'
                        : 'Buy More Diamonds Or Change Your Entry.'
                      : !validPlinkoBudget(budget)
                        ? `Your Entry Plays ${PLINKO_DROPS} Whole Diamonds Per Drop. Choose A Multiple Of ${PLINKO_DROPS}.`
                        : !table
                          ? budget.doubled
                            ? 'This Bonus Does Not Cover A Doubled Entry. Choose Keep My Bonus To Play.'
                            : 'The Plinko Table Is Not Open For This Entry. Return To The Wheel.'
                          : waitSeconds > 0
                            ? `Your Next Drop Is Ready In ${waitSeconds} Seconds.`
                            : 'Checking This Entry And The Available Prize Cover'}
          </p>
        )}
      </GameConsole>
      <GamePanel title="How To Play" pill="Rules" foot="foot">
        <p className="sc-copy">
          Your Entry Plays {PLINKO_DROPS} Drops Of A Tenth Of It Each. Every Diamond Lands In A
          Prize Slot, And Your Chips Are Booked Automatically When The Last Drop Lands.
        </p>
        <p className="sc-copy">
          One Table For Every Game. Nobody Picks A Risk Level; It Is Built Into The Payout. The
          Outer Slots Pay Up To {multiplierLabel(2000)}, And The Middle Slots Pay The Least.
        </p>
        {table && (
          <p className="sc-copy">
            This Game Plays The {table.name} Table, Top Prize{' '}
            {multiplierLabel(table.max_multiplier_cents)} Per Drop.
            {isSuper
              ? ` Every Super Slot Pays, So The ${PLINKO_DROPS} Drops Return At Least Your Original Spin.`
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
            onBlur={(e) => {
              if (!e.target.value.trim()) setSeed(randomClientSeed());
            }}
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
          chips={result.payout_chips}
          detail={`${result.drops.length} Drops Completed.`}
        />
      )}
    </div>
  );
}
