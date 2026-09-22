import { useLiveBonusGuard } from '../hooks/useLiveBonusGuard';
import { pendingBonus, PriorBonusPending } from '../services/diamondBonusRecovery';
import { useBonusBudget } from '../hooks/useBonusBudget';
import { useEarnedBonus } from '../hooks/useEarnedBonus';
import DiamondSpinsTabs from '../components/games/DiamondSpinsTabs';
import BonusCompletion from '../components/games/BonusCompletion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { GameConsole, GamePanel } from '../components/games/GameConsole';
import BonusSetup, { guaranteeCopy } from '../components/games/BonusSetup';
import TodayLine from '../components/games/TodayLine';
import SealedPrize from '../components/games/SealedPrize';
import { useGameCooldown } from '../hooks/useGameCooldown';
import { useAutoSettle, useStandingRefresh } from '../hooks/useAutoSettle';
import { useAwardAutoStart, useRefusedAward } from '../hooks/useAwardAutoStart';
import {
  bonusTotal,
  bonusWalletDebit,
  earnedReceiptBudget,
  gameChips,
  validBonusBudget,
} from '../utils/bonusGameBudget';
import {
  DiamondBonusService,
  BonusRefusal,
  BonusUnreadable,
  BONUS_SAVED,
  type BonusStart,
} from '../services/DiamondBonusService';
import ChoiceScene from '../components/games/ChoiceScene';
import {
  DiamondChoiceService,
  parseChoiceRound,
  type ChoiceRound,
  type ChoiceState,
} from '../services/DiamondChoiceService';
import { supabase } from '../lib/supabase';
import {
  CHOICE_MODE,
  ROAD_LADDERS,
  roadSurvives,
  verifyChoiceRound,
  type ChoiceGame,
  type RoadRisk,
} from '../utils/diamondChoiceMath';
import { diamondBonusMinimum } from '../utils/diamondBonusPayout';
import { diamondGameTitle } from '../utils/diamondGameTitles';
import { randomClientSeed } from '../utils/wheelFairness';
import { compactChips } from '../utils/format';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { triggerHaptic } from '../services/HapticService';
import { soundService } from '../services/SoundService';
import '../components/console/SpadeConsole.css';
import styles from './diamondGames.module.css';

interface Ticket {
  id: string;
  hash: string;
}
/** "1.10x" and "20.00x": the road's multipliers always read with two decimals. */
const multiplierCopy = (cents: number) => `${(cents / 100).toFixed(2)}x`;
const ROAD = ROAD_LADDERS[CHOICE_MODE.crossing];
/** What the page says while it mends something by itself. None of these asks
 * the player to do anything, so none of them reads as an error. */
const RECONNECTING = 'Reconnecting To Your Game';
const PREPARING_TICKET = 'Preparing Your Ticket';
const CALM = new Set([
  RECONNECTING,
  PREPARING_TICKET,
  'Settling Your Round',
  'Settling Your Previous Round First',
  'Confirming Your Move',
  BONUS_SAVED,
]);
/** What the rules say about the one setting, from the same constants the server mirrors. */
const ONE_SETTING = {
  crossing: `${ROAD.length} Streets Pay ${multiplierCopy(ROAD[0])} Up To ${multiplierCopy(ROAD[ROAD.length - 1])}.`,
  mines: `${CHOICE_MODE.mines} Mines Hide Among 25 Tiles.`,
} as const;
export default function DiamondChoicePage({ game }: { game: ChoiceGame }) {
  const { user } = useAuthUser();
  const { clubId } = useParams();
  return <DiamondChoiceGame key={`${user?.id ?? ''}:${clubId ?? ''}:${game}`} game={game} />;
}
function DiamondChoiceGame({ game }: { game: ChoiceGame }) {
  const { clubId } = useParams();
  const { user } = useAuthUser();
  const navigate = useNavigate();
  const [uuid, setUuid] = useState<string | null>(null);
  const [legacyState, setState] = useState<ChoiceState | null>(null);
  const [quotedEntry, setQuotedEntry] = useState<string | null>(null);
  const [round, setRound] = useState<ChoiceRound | null>(null);
  // The round the console is still PRINTING while the scene plays the street
  // out. The confirmed answer lands in `round` the moment the server speaks;
  // the pill, the bays, the readout and the plate labels keep showing the
  // round the player can still see until the scene says the donkey got there.
  const [printed, setPrinted] = useState<ChoiceRound | null>(null);
  const [completionId, setCompletionId] = useState<string | null>(null);
  const [revealedId, setRevealedId] = useState<string | null>(null);
  // The one setting. Nobody picks a difficulty; the payout carries it, and the
  // server refuses any other mode for a new round. A saved open round keeps its own.
  const mode = CHOICE_MODE[game];
  const [selectedBudget, setBudget] = useBonusBudget(clubId, game);
  const earned = useEarnedBonus(uuid, game, selectedBudget, mode);
  const budget = earned.budget;
  const state = (earned.gameState as ChoiceState | null) ?? legacyState;
  const bet = bonusTotal(budget);
  const [seed, setSeed] = useState(randomClientSeed);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [busy, setBusy] = useState(false);
  const [sceneBusy, setSceneBusy] = useState(false);
  // The player has committed to the next street and the server has not
  // answered. Only a crossing pick: a start, a settle and an uncertain round
  // are all `busy`, and none of them is the donkey stepping to the kerb.
  const [moving, setMoving] = useState(false);
  // The move the player has committed to, named on the plate they pressed and
  // in the pill, until the result is theirs to see. A crossing pick belongs to
  // the scene from here: it clears when the donkey lands, so the plate does not
  // go back to naming a street the player has not been shown yet.
  const [pendingAction, setPendingAction] = useState<'cross' | 'reveal' | 'book' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A wager whose answer never arrived, or a move whose confirmed result the
  // page has not read yet. The page settles it on its own schedule
  // (useAutoSettle); the player is never asked to check anything.
  const [uncertain, setUncertain] = useState(false);
  const [settleAttempts, setSettleAttempts] = useState(0);
  // The server answered the saved wager BONUS_SENDS_PER_REQUEST times and this
  // browser could verify none of the answers. It stays saved (money may have
  // moved) and is sent again on the next visit; on this one nothing more is
  // sent for it and nothing holds the player.
  const [saved, setSaved] = useState(false);
  // The server refused a ticket that could no longer open a round and charged
  // nothing, so the same wager goes again on a fresh ticket - once per press.
  const [restartOwed, setRestartOwed] = useState(false);
  // The Double Down offer is a question about the player's own diamonds. A won
  // game never starts itself over it; it is treated as open until the setup
  // panel says otherwise.
  const [offerOpen, setOfferOpen] = useState(true);
  // A game read or a ticket deal that failed is tried again by the page
  // itself, on the same schedule as a saved wager. Nobody is told to refresh.
  const [loadFailures, setLoadFailures] = useState(0);
  const [loadTry, setLoadTry] = useState(0);
  const [ticketFailures, setTicketFailures] = useState(0);
  const [ticketTry, setTicketTry] = useState(0);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [waitSeconds, setWaitSeconds] = useGameCooldown();
  const mounted = useRef(true),
    busyRef = useRef(false),
    generation = useRef(0);
  const currentRound = useRef(round);
  currentRound.current = round;
  const uncertainTicket = useRef<string | null>(null);
  const heldStart = useRef<BonusStart | null>(null);
  // The exact wager the server refused for its ticket alone. It goes again,
  // unchanged but for the fresh ticket: never rebuilt from what the page
  // happens to show by then (another award, another Double Down answer).
  const owed = useRef<BonusStart | null>(null);
  const upgraded = round
    ? earnedReceiptBudget(round as unknown as Record<string, unknown>)?.award?.boostMultiplier === 2
    : budget.award?.boostMultiplier === 2;
  const title = diamondGameTitle(game, upgraded ? 2 : 1);

  const load = useCallback(
    async (id: string) => {
      const g = ++generation.current;
      setQuotedEntry(null);
      const next = await DiamondChoiceService.state(id, game, mode, Math.min(bet, 5000));
      if (!mounted.current || generation.current !== g) return;
      setState(next);
      setQuotedEntry(`${id}:${game}:${mode}:${bet}`);
      setWaitSeconds(next.seconds_until_next);
      if (next.open_round) {
        setRound(next.open_round);
        setCompletionId(next.open_round.id);
        setBudget((current) =>
          bonusTotal(current) === next.open_round!.bet_diamonds
            ? current
            : (earnedReceiptBudget(next.open_round! as unknown as Record<string, unknown>) ?? {
                base:
                  next.open_round!.bet_diamonds > 2500
                    ? next.open_round!.bet_diamonds / 2
                    : next.open_round!.bet_diamonds,
                doubled: next.open_round!.bet_diamonds > 2500,
                denomination: 1,
              })
        );
        setTicket(null);
        if (!heldStart.current) {
          setUncertain(false);
          uncertainTicket.current = null;
        }
      } else {
        const current = currentRound.current;
        const finished = next.history.find(
          (r) => r.id === current?.id || r.commit_id === uncertainTicket.current
        );
        if (finished) setRound(finished);
        if (!heldStart.current) {
          setUncertain(false);
          uncertainTicket.current = null;
        }
      }
      return next;
    },
    [game, mode, bet, setBudget, setWaitSeconds]
  );

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    (async () => {
      if (!clubId) return;
      try {
        const id = await resolveClubUUID(clubId);
        if (cancelled) return;
        setUuid(id);
        const pending = pendingBonus(user?.id ?? '', id, game);
        if (pending) {
          // Replayed by useAutoSettle as soon as the game state is in.
          heldStart.current = pending;
          uncertainTicket.current = pending.commitId;
          setBudget(pending.budget);
          setSeed(pending.seed);
          setUncertain(true);
        }
        await load(id);
        if (!cancelled) {
          setLoadFailures(0);
          setError((current) => (current === RECONNECTING ? null : current));
        }
      } catch (e) {
        reportError(e, 'DiamondChoicePage.load');
        if (!cancelled) {
          setError(RECONNECTING);
          setLoadFailures((count) => count + 1);
        }
      }
    })();
    return () => {
      cancelled = true;
      mounted.current = false;
      generation.current++;
    };
  }, [clubId, user?.id, load, game, setBudget, loadTry]);
  useAutoSettle(loadFailures > 0, loadFailures, async () => {
    setLoadTry((count) => count + 1);
    return true;
  });

  const newTicket = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('fn_diamond_game_commit', {
      p_game: game,
    });
    if (rpcError) throw rpcError;
    const value = data as unknown as {
      ok: boolean;
      commit_id: string;
      server_seed_hash: string;
      error?: string;
    };
    if (
      value?.ok !== true ||
      typeof value.commit_id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.commit_id) ||
      typeof value.server_seed_hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.server_seed_hash)
    )
      throw new Error(value?.error ?? 'The Game Ticket Could Not Be Loaded');
    const next = { id: value.commit_id, hash: value.server_seed_hash };
    if (mounted.current) setTicket(next);
    return next;
  }, [game]);

  // A commitment is obtained and displayed before the player starts the wager.
  useEffect(() => {
    if (!state?.available || round?.status === 'open' || ticket || uncertain) return;
    let cancelled = false;
    newTicket()
      .then(() => {
        if (cancelled) return;
        setTicketFailures(0);
        setError((current) => (current === PREPARING_TICKET ? null : current));
      })
      .catch((e) => {
        reportError(e, 'DiamondChoicePage.ticket');
        if (cancelled) return;
        setError(PREPARING_TICKET);
        setTicketFailures((count) => count + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [state?.available, round?.status, ticket, uncertain, newTicket, ticketTry]);
  useAutoSettle(ticketFailures > 0 && !ticket && !uncertain, ticketFailures, async () => {
    setTicketTry((count) => count + 1);
    return true;
  });

  /** Stop sending a saved wager whose answers will not verify, let the player
   * go, and read the game again: the read shows any round the wager opened. */
  const keepForNextVisit = (id: string) => {
    setSaved(true);
    setError(BONUS_SAVED);
    void earned.refresh();
    void load(id).catch((readError) => reportError(readError, 'DiamondChoicePage.saved'));
  };
  const refresh = async (): Promise<boolean> => {
    if (!uuid || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      if (heldStart.current) {
        const recovered = parseChoiceRound(
          await DiamondBonusService.start(heldStart.current, user?.id ?? '')
        );
        if (!mounted.current) return true;
        earned.consume(recovered.award_id);
        currentRound.current = recovered;
        setRound(recovered);
        setCompletionId(recovered.id);
        heldStart.current = null;
        uncertainTicket.current = null;
        setUncertain(false);
        setTicket(null);
      }
      await earned.refresh();
      await load(uuid);
      if (mounted.current) {
        setError(null);
        setSettleAttempts(0);
      }
    } catch (e) {
      reportError(e, 'DiamondChoicePage.refresh');
      if (mounted.current) {
        if (e instanceof BonusRefusal) {
          const refused = heldStart.current;
          heldStart.current = null;
          uncertainTicket.current = null;
          setUncertain(false);
          setSettleAttempts(0);
          setTicket(null);
          setError(e.message);
          settleRefusal(e, refused);
        } else if (e instanceof BonusUnreadable && e.final) {
          keepForNextVisit(uuid);
        } else {
          // Not an answer: the page tries again on its own schedule.
          setSettleAttempts((count) => count + 1);
          setError('Settling Your Round');
        }
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
    return true;
  };
  useAutoSettle(uncertain && !saved, settleAttempts, refresh);
  // What the server's own state says about starting now. Deliberately without
  // the entry quote, which blinks off during every start and must not count as
  // the server changing its mind.
  const stateBlocked =
    !earned.ready ||
    !validBonusBudget(budget) ||
    !state?.available ||
    state.frozen ||
    !state.is_member ||
    state.max_steps < 1 ||
    state.rounds_today >= state.daily_limit ||
    waitSeconds > 0 ||
    state.diamonds < bonusWalletDebit(budget);
  const blocked = stateBlocked || quotedEntry !== `${uuid}:${game}:${mode}:${bet}`;
  const refusal = useRefusedAward(earned.award?.id, stateBlocked);
  /** One place decides what a refusal means; the start and the replay both land here. */
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
  /** Starts the round the page shows, or - given `resend` - re-sends exactly the
   * wager the server refused for its ticket, on the ticket now in hand. */
  const start = async (resend?: BonusStart) => {
    if (
      !uuid ||
      !ticket ||
      !state ||
      busyRef.current ||
      uncertain ||
      round?.status === 'open' ||
      (!resend && blocked)
    )
      return;
    busyRef.current = true;
    generation.current++;
    setQuotedEntry(null);
    setBusy(true);
    setError(null);
    setVerified(null);
    // An emptied "Your Seed" is not a decision the player made about this
    // round: the service refuses a blank seed before anything is sent, and
    // that refusal reads to the page exactly like the server's own. The page
    // deals itself a seed instead, and shows the one the round was sent with,
    // so Round Proof still names what was actually used. A resend keeps its
    // own seed, because it is the same wager going again.
    const sent = seed.trim() ? seed : randomClientSeed();
    if (sent !== seed) setSeed(sent);
    const request: BonusStart = resend
      ? { ...resend, commitId: ticket.id, serverSeedHash: ticket.hash }
      : {
          clubId: uuid,
          game,
          mode,
          budget,
          commitId: ticket.id,
          serverSeedHash: ticket.hash,
          seed: sent,
          maxSteps: state.max_steps,
        };
    uncertainTicket.current = request.commitId;
    heldStart.current = request;
    try {
      const next = parseChoiceRound(await DiamondBonusService.start(request, user?.id ?? ''));
      if (!mounted.current) return;
      earned.consume(next.award_id);
      currentRound.current = next;
      setRound(next);
      setCompletionId(next.id);
      heldStart.current = null;
      setTicket(null);
      uncertainTicket.current = null;
      setUncertain(false);
      triggerHaptic('light');
      await load(uuid);
    } catch (e) {
      reportError(e, 'DiamondChoicePage.start');
      if (mounted.current) {
        if (e instanceof PriorBonusPending) {
          // Another tab's wager is still saved: it settles first, by itself.
          heldStart.current = e.prior;
          uncertainTicket.current = e.prior.commitId;
          setBudget(e.prior.budget);
          setUncertain(true);
          setSettleAttempts(0);
          setError('Settling Your Previous Round First');
        } else if (e instanceof BonusRefusal) {
          // Nothing was charged. The ticket is spent either way, so a fresh
          // one is dealt; when the ticket itself was the refusal the same
          // wager is sent again on it.
          const refused = heldStart.current;
          heldStart.current = null;
          uncertainTicket.current = null;
          setUncertain(false);
          setTicket(null);
          setError(e.message);
          settleRefusal(e, refused);
          // This start cleared the entry quote. Read it again, so the next
          // start is not held on "Checking Your Entry" until someone refreshes.
          void load(uuid).catch((requoteError) => {
            reportError(requoteError, 'DiamondChoicePage.requote');
            if (mounted.current) setLoadFailures((count) => count + 1);
          });
        } else if (e instanceof BonusUnreadable && e.final) {
          setUncertain(true);
          keepForNextVisit(uuid);
        } else {
          // The answer never arrived. The saved wager is replayed by
          // useAutoSettle until the server says what happened.
          setUncertain(true);
          setSettleAttempts(0);
          setError('Settling Your Round');
        }
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const act = async (action: 'pick' | 'cashout', cell: number | null) => {
    if (!uuid || !round || round.status !== 'open' || busyRef.current || uncertain || sceneBusy)
      return;
    const stepping = game === 'crossing' && action === 'pick';
    let handedToScene = false;
    busyRef.current = true;
    setPendingAction(action === 'cashout' ? 'book' : game === 'crossing' ? 'cross' : 'reveal');
    // A stale read in flight must not rewind the donkey; the entry quote is
    // left alone, because a move never changes what a new round would cost.
    generation.current++;
    setBusy(true);
    if (stepping) setMoving(true);
    setError(null);
    setVerified(null);
    try {
      const next = await DiamondChoiceService.act(round, action, cell);
      if (!mounted.current) return;
      currentRound.current = next;
      if (
        game === 'crossing' &&
        action === 'pick' &&
        (next.status !== round.status || next.picked.length !== round.picked.length)
      ) {
        setPrinted(round);
        setSceneBusy(true);
        handedToScene = true;
      }
      setRound(next);
      // Mines turns its tile over on this answer, so its buzz belongs here. A
      // crossing's does not: the donkey is still in the road, and a buzz now
      // would give the result away three quarters of a second before the car
      // reaches it. The scene fires the crossing's beats instead.
      if (game !== 'crossing') triggerHaptic(next.status === 'lost' ? 'heavy' : 'light');
      // THE ANSWER IS THE ROUND. fn_choice_act returns the whole round, and an
      // open street needs nothing else: the budget, the ticket, the completion
      // id and the entry quote the page holds are the ones this move was made
      // on. Only a round that has ENDED reads the game again - for today's
      // count, the cooldown and the receipt list - and that read is background
      // work on the retry path start() already uses, never this move's
      // confirmation. Losing it used to withhold the receipt and hold the
      // player on an unconfirmed money move that the server had in fact
      // answered.
      if (next.status !== 'open')
        void load(uuid).catch((readError) => {
          reportError(readError, 'DiamondChoicePage.afterMove');
          if (mounted.current) setLoadFailures((count) => count + 1);
        });
    } catch (e) {
      // Only the move itself can land here now. Money may have moved, so
      // nothing is printed: the confirmed result is read back by useAutoSettle.
      reportError(e, 'DiamondChoicePage.act');
      if (mounted.current) {
        setUncertain(true);
        setSettleAttempts(0);
        setError('Confirming Your Move');
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        setBusy(false);
        if (stepping) setMoving(false);
        if (!handedToScene) setPendingAction(null);
      }
    }
  };
  // A wager the server refused for its ticket alone is sent again on the
  // fresh ticket, once, without the player pressing Start twice.
  const startRef = useRef(start);
  startRef.current = start;
  const restarts = useRef(0);
  useEffect(() => {
    // The owed wager is re-sent as it was; only the server decides whether it
    // can still start (a refusal now settles like any other).
    if (!restartOwed || !ticket || uncertain || busy || round?.status === 'open') return;
    setRestartOwed(false);
    const wager = owed.current;
    owed.current = null;
    if (!wager || restarts.current >= 2) return;
    restarts.current += 1;
    void startRef.current(wager);
  }, [restartOwed, ticket, uncertain, busy, round?.status]);
  // Games paused by the platform come back by themselves after the break.
  useStandingRefresh(Boolean(state?.frozen) && !busy && !uncertain && !sceneBusy, () => {
    void earned.refresh();
    setLoadTry((count) => count + 1);
  });
  const open = round?.status === 'open';
  // A won game starts itself: a short visible countdown, then the same Start
  // the button would have pressed. A finished round still on the scene keeps
  // the floor until its completion has taken the player back to the wheel.
  const finishedOnScene = Boolean(round && round.status !== 'open' && completionId === round.id);
  const autoStartIn = useAwardAutoStart(
    earned.award?.id,
    !open &&
      !uncertain &&
      !busy &&
      !sceneBusy &&
      !blocked &&
      Boolean(ticket) &&
      !restartOwed &&
      !offerOpen &&
      !finishedOnScene &&
      !refusal.refused,
    // Typing still restarts the five seconds; an empty field is typing too,
    // and start() deals the seed it sends.
    `${bet}:${seed}:${refusal.opening}`,
    () => void startRef.current()
  );
  // Presentation only. Every gate - the exit guard, the auto-start, the
  // receipt, the round the scene is given - still reads `round` itself.
  const view = printed ?? round;
  const viewOpen = view?.status === 'open';
  const picks = view?.picked.length ?? 0;
  const prizes = viewOpen ? view.prizes : (state?.prizes ?? []);
  const prize =
    view?.status === 'lost'
      ? view.payout_chips
      : view?.status === 'cashed'
        ? view.payout_chips
        : viewOpen && picks > 0
          ? prizes[picks - 1]
          : 0;
  const nextPrize = viewOpen ? prizes[picks] : view ? undefined : prizes[0];
  const ladder = ROAD_LADDERS[(round?.mode ?? mode) as RoadRisk];
  const roadEnd =
    game === 'crossing' && round?.proof && ladder
      ? ladder.filter((target) =>
          roadSurvives(
            BigInt(round.proof!.road_roll),
            target,
            round.bet_chips,
            round.minimum_payout_chips ?? 0
          )
        ).length
      : null;
  const roadMultiplier = roadEnd !== null && roadEnd > 0 ? ladder[roadEnd - 1] : 0;
  const payableRoadEnd = Math.min(roadEnd ?? 0, round?.max_steps ?? 0);
  /** ONE NAME PER OUTCOME. Where the road really ended, said the one way the
   * scene, the readout, the receipt and the history row all say it. */
  const roadEnded =
    roadEnd === null || !ladder
      ? null
      : roadEnd >= ladder.length
        ? `The Donkey Would Have Crossed Every Street, To ${multiplierCopy(roadMultiplier)}`
        : roadEnd <= picks
          ? `Street ${roadEnd + 1} Was The Crash`
          : `The Donkey Would Have Made It To Street ${roadEnd} At ${multiplierCopy(roadMultiplier)}`;
  const bookedAt =
    picks > 0 && ladder ? multiplierCopy(ladder[Math.min(picks, ladder.length) - 1]) : null;
  /** A finished round in Recent Rounds, named the way the scene named it. */
  const historyRow = (item: ChoiceRound) => {
    const upgrade =
      earnedReceiptBudget(item as unknown as Record<string, unknown>)?.award?.boostMultiplier === 2
        ? 'Super · '
        : '';
    if (game !== 'crossing')
      return `${upgrade}${item.status === 'cashed' ? 'Win Booked' : 'Round Over'}`;
    const rungs = ROAD_LADDERS[item.mode as RoadRisk];
    const street = item.picked.length;
    if (item.status !== 'cashed')
      return `${upgrade}Hit At Street ${street}${item.payout_chips > 0 ? ' · Guarantee Paid' : ''}`;
    return `${upgrade}Booked At Street ${street}${
      rungs && street > 0 ? ` · ${multiplierCopy(rungs[Math.min(street, rungs.length) - 1])}` : ''
    }`;
  };
  const status = saved
    ? 'Saved'
    : uncertain
      ? 'Settling'
      : busy || pendingAction
        ? pendingAction === 'cross'
          ? 'Crossing'
          : pendingAction === 'reveal'
            ? 'Revealing'
            : pendingAction === 'book'
              ? 'Booking Win'
              : 'Starting'
        : viewOpen
          ? 'In Play'
          : view?.status === 'cashed'
            ? 'Win Booked'
            : view?.status === 'lost'
              ? game === 'crossing'
                ? `Hit At Street ${picks}`
                : 'Round Over'
              : 'Ready';
  // Money in flight holds the page. A won game holds it only while it can
  // actually start: an award this page cannot start (daily limit, a closed or
  // frozen game, a cooldown, no ticket dealt yet) never traps the player on
  // it, and neither does the next award while a finished round's receipt is
  // waiting to take them back to the wheel.
  // A wager kept for the next visit has nothing in flight: it holds nothing.
  useLiveBonusGuard(
    !saved &&
      ((Boolean(earned.award) &&
        !blocked &&
        Boolean(ticket) &&
        !finishedOnScene &&
        !refusal.refused) ||
        busy ||
        uncertain ||
        open ||
        sceneBusy),
    () => setError('Finish Your Bonus Game Before Leaving.')
  );
  // EVERY CHOICE NAMES ITS CHIPS. The game is one decision - take this amount
  // or risk it for that one - and until now neither number was on the plate the
  // player pressed. Both read from `view`, so they change on the landing the
  // scene shows, never on the answer the server gave before it.
  const bookable = viewOpen && picks > 0 ? gameChips(prize ?? 0) : null;
  const cashLabel = bookable === null ? 'Refresh' : `Book ${bookable}`;
  const crossable = game === 'crossing' && viewOpen && nextPrize !== undefined ? nextPrize : null;
  // History is available for proof, but must not replay an old collision on entry.
  const sceneRound = round?.id === completionId ? round : null;
  const phase = sceneRound?.status ?? 'idle';
  // The chips the next round would stake, and the chips the round on the scene did.
  const entryChips = state && validBonusBudget(budget) ? bet / state.diamonds_per_chip : undefined;
  const stakeChips = sceneRound?.bet_chips ?? entryChips;
  // What any loss or un-cashed round pays, shown before Start. The server's own
  // quote speaks for an award; an open round carries its sealed floor; ordinary
  // play keeps the tenth the server enforces and every receipt verifies.
  const standardFloor = (() => {
    if (entryChips === undefined) return null;
    try {
      return diamondBonusMinimum(entryChips, 1);
    } catch {
      return null;
    }
  })();
  const guaranteedChips = viewOpen
    ? (view.minimum_payout_chips ?? 0)
    : earned.quote
      ? earned.quote.minimumPayoutChips
      : earned.ready && !earned.award
        ? standardFloor
        : null;
  const guaranteedSuper = viewOpen ? upgraded : earned.quote?.guarantee === 'super';
  const promise = earned.quote ? guaranteeCopy(game, earned.quote) : null;
  // The finished round's receipt is on screen, taking the player back to the
  // wheel. One condition, read by the receipt itself and by the scene behind it.
  const receiptShowing = Boolean(
    round &&
    round.status !== 'open' &&
    completionId === round.id &&
    revealedId === round.id &&
    !uncertain &&
    !busy
  );
  /**
   * ONE SPOKEN LINE PER STREET. The scene's readout, its bust stamp and the
   * paragraphs below were four live regions between them, so a hit was read
   * out three or four times over, all of it before the car had moved, and a
   * safe street announced a new cash-out value without ever saying which
   * street had been crossed. The page keeps the one polite region now, and a
   * crossing in play carries this sentence in it: built from `view`, so it
   * changes when the scene says the donkey landed, in the words the sighted
   * player reads.
   */
  const crossingSpoken =
    game === 'crossing' && viewOpen
      ? [
          picks === 0 ? 'The Crossing Is Open.' : `Street ${picks} Crossed.`,
          nextPrize === undefined
            ? `The Final Street. Book ${gameChips(prize ?? 0)} Chips Now.`
            : picks === 0
              ? `The First Street Pays ${gameChips(nextPrize)} Chips.`
              : `Book ${gameChips(prize ?? 0)} Chips Now Or Cross For ${gameChips(nextPrize)}.`,
          guaranteedChips === null ? '' : `A Hit Pays ${gameChips(guaranteedChips)}.`,
        ]
          .filter(Boolean)
          .join(' ')
      : null;
  return (
    <div className={`${styles.page} ${styles.fullscreenPage}`}>
      <button
        type="button"
        className={styles.back}
        onClick={() => navigate(`/clubs/${clubId}/diamond-games`)}
      >
        ‹ Diamond Spins
      </button>
      <DiamondSpinsTabs clubId={clubId ?? ''} />
      <GameConsole
        setup={
          !open && (
            <BonusSetup
              game={game}
              guarantee={earned.quote}
              budget={budget}
              entryReady={earned.ready}
              awardLoading={earned.loading}
              awardError={earned.error}
              onChange={setBudget}
              onOffer={setOfferOpen}
              diamonds={state?.diamonds ?? null}
              disabled={busy || uncertain || restartOwed}
              clubId={clubId ?? ''}
            />
          )
        }
        title={title}
        eyebrow="Diamond Spins"
        pill={status}
        pillInk={round?.status === 'cashed' ? 'green' : 'blue'}
        bays={[
          {
            label: 'Guaranteed',
            value: guaranteedChips === null ? 'Pending' : `${gameChips(guaranteedChips)} Chips`,
            ink: guaranteedSuper ? 'gold' : undefined,
          },
          {
            label: game === 'mines' ? 'Revealed' : 'Street',
            value: String(picks),
            disabled: true,
          },
          { label: 'Current Prize', value: gameChips(prize ?? 0), ink: 'gold' },
          {
            label: 'Next Prize',
            value: nextPrize === undefined ? 'N/A' : gameChips(nextPrize),
            ink: 'gold',
          },
        ]}
        secondary={{
          label: pendingAction === 'book' ? 'Booking Win' : cashLabel,
          'aria-label':
            pendingAction === 'book' || bookable === null
              ? undefined
              : `Book The Win For ${bookable} Chips`,
          // Inside the tap: the one place an iOS switch haptic is granted.
          onClick: () => {
            if (open && picks > 0 && !uncertain) {
              triggerHaptic('selection');
              void act('cashout', null);
            } else void refresh();
          },
          // In flight: the plate keeps the player's focus. Unavailable: it does
          // not. A wager the page is still settling is unavailable.
          disabled: uncertain,
          'aria-disabled': busy || sceneBusy || undefined,
        }}
        primary={{
          label:
            pendingAction === 'cross'
              ? 'Crossing'
              : viewOpen
                ? game === 'crossing'
                  ? crossable === null
                    ? 'Cross Street'
                    : `Cross For ${gameChips(crossable)}`
                  : 'Choose A Tile'
                : waitSeconds > 0
                  ? `Ready In ${waitSeconds}s`
                  : autoStartIn !== null
                    ? `Starting In ${autoStartIn}s`
                    : 'Start Round',
          'aria-label':
            pendingAction === 'cross' || crossable === null
              ? undefined
              : `Cross Street ${picks + 1} For ${gameChips(crossable)} Chips`,
          onClick: () => {
            if (!open) {
              void start();
              return;
            }
            triggerHaptic('selection');
            void act('pick', picks);
          },
          disabled: uncertain || (open ? game === 'mines' : blocked || !ticket),
          'aria-disabled': busy || sceneBusy || undefined,
        }}
      >
        <TodayLine
          used={state?.rounds_today ?? 0}
          cap={state?.daily_limit ?? 0}
          spentDiamonds={state?.diamonds_today ?? 0}
          noun="Rounds"
        />
        <ChoiceScene
          game={game}
          roundId={sceneRound?.id}
          onSettled={() => {
            setPrinted(null);
            setPendingAction(null);
            setSceneBusy(false);
            if (sceneRound && sceneRound.status !== 'open') setRevealedId(sceneRound.id);
          }}
          // The scene reached the beat it was holding: the console prints the
          // confirmed round from here on.
          onMoment={(moment, street) => {
            setPrinted(null);
            setPendingAction(null);
            // THE BEATS ARE THE SCENE'S. It is the only thing that knows where
            // the donkey is, so what the player hears and feels lands with
            // what they see. Both services honour the player's own sound and
            // vibration switches; the explicit buzz keeps the street's beat
            // when the sound is muted, and vibrationGate coalesces it with the
            // tick's own within 60 ms.
            if (moment === 'landed') {
              soundService.playSpinTick();
              triggerHaptic('light');
            } else if (moment === 'hit') {
              // Crash's rule, which this game now shares: a loss says nothing.
              triggerHaptic('heavy');
            } else {
              soundService.playSpinMultiplierResult(
                (ladder?.[Math.min(Math.max(street, 1), ladder.length) - 1] ?? 100) / 100
              );
              triggerHaptic('success');
            }
          }}
          // Nothing is looking at the road: the Double Down offer stands over
          // an idle scene, or the receipt stands over a finished one. Never on
          // offerOpen alone, which starts true and stays true for a resumed
          // open round, and would freeze that round's reveal for good.
          paused={(phase === 'idle' && offerOpen && Boolean(earned.award)) || receiptShowing}
          moving={moving}
          phase={phase}
          picked={sceneRound?.picked ?? []}
          mines={sceneRound?.proof?.mine_cells ?? null}
          roadEnd={sceneRound ? roadEnd : null}
          busy={busy || uncertain}
          onPick={(cell) => void act('pick', cell)}
          ladder={
            game === 'crossing' ? ROAD_LADDERS[(sceneRound?.mode ?? mode) as RoadRisk] : undefined
          }
          prizes={sceneRound ? sceneRound.prizes : prizes}
          betChips={stakeChips}
          floorChips={guaranteedChips}
          superFloor={guaranteedSuper}
          payoutChips={
            sceneRound && sceneRound.status !== 'open' ? sceneRound.payout_chips : undefined
          }
        />
        <div className={styles.readout} aria-live="polite" aria-atomic="true">
          {crossingSpoken ? <p className="sr-only">{crossingSpoken}</p> : null}
          {error ? (
            CALM.has(error) ? (
              <p className="sc-copy">{error}</p>
            ) : (
              <p className="sc-copy sc-ink--red">{error}</p>
            )
          ) : null}
          {view?.status === 'cashed' ? (
            <>
              <strong className="sc-ink--gold">{gameChips(view.payout_chips)} Chips Booked</strong>
              <p className="sc-copy">
                {game === 'mines'
                  ? 'All Remaining Mines Are Revealed. Your Win Is Saved.'
                  : `${bookedAt === null ? 'Your Win Is Booked.' : `Booked At Street ${picks} At ${bookedAt}.`}${roadEnded === null ? '' : ` ${roadEnded}.`}${payableRoadEnd < (roadEnd ?? 0) ? ` Your Round Would Have Booked At Its Street ${payableRoadEnd} Limit First.` : ''}`}{' '}
                {game === 'crossing' && payableRoadEnd > 0 && view.proof ? (
                  <SealedPrize
                    serverSeed={view.proof.server_seed}
                    clientSeed={view.client_seed}
                    nonce={view.nonce}
                    betChips={view.bet_chips}
                    multiplierCents={ladder[payableRoadEnd - 1]}
                    roundingStep={payableRoadEnd}
                  />
                ) : null}
              </p>
            </>
          ) : view?.status === 'lost' ? (
            <p className="sc-copy">
              {game === 'mines'
                ? `A Mine Ended This Round. All Mines Are Revealed. ${gameChips(view.payout_chips)} Chips Booked.`
                : `Hit At Street ${picks}. Your Guaranteed ${gameChips(view.payout_chips)} Chips Are Booked.`}
            </p>
          ) : (
            <p className="sc-copy">
              {viewOpen
                ? game === 'mines'
                  ? 'Reveal A Tile Or Book The Win.'
                  : 'Cross The Next Street Or Book The Win.'
                : !earned.ready
                  ? (earned.error ??
                    (earned.loading
                      ? 'Checking Your Wheel Award'
                      : 'Win This Game On Diamond Spins To Play.'))
                  : !state
                    ? 'Loading Your Game'
                    : quotedEntry !== `${uuid}:${game}:${mode}:${bet}`
                      ? 'Checking Your Entry'
                      : blocked
                        ? state.frozen
                          ? 'Games Are Paused For Maintenance. Play Resumes By Itself After The Break.'
                          : state.diamonds < bonusWalletDebit(budget)
                            ? 'Not Enough Diamonds For This Bet'
                            : !state.is_member
                              ? 'Join The Club To Play'
                              : !state.available
                                ? 'This Game Is Not Open Here Yet'
                                : 'This Bet Is Not Available Right Now'
                        : `${promise ?? `${compactChips(bet)} Diamonds To Play.`} ${state.max_steps} ${game === 'mines' ? 'Safe Picks' : 'Streets'} In This Round.`}
            </p>
          )}
        </div>
      </GameConsole>
      <GamePanel
        title="Your Game"
        pill="Rules"
        eyebrow={`${compactChips(state?.diamonds ?? 0)} Diamonds`}
        foot="foot"
      >
        <p className="sc-copy">
          {game === 'mines'
            ? `${ONE_SETTING.mines} Pick Hidden Gems On The Board; Every Safe Pick Raises Your Prize. Book The Win After Any Safe Pick, And The Remaining Mines Are Then Revealed. A Mine Ends The Round And Pays The Guaranteed Minimum.`
            : `Guide The Donkey Across The Road. ${ONE_SETTING.crossing} Each Safe Crossing Raises Your Prize. Book The Win After Any Street. A Hit Ends The Round And Pays The Guaranteed Minimum. Traffic Animation Does Not Change The Outcome.`}
        </p>
        {game === 'crossing' ? (
          <p className="sc-copy">
            Where The Donkey Would Be Hit Is Sealed Before You Start; Your Only Choice Is When To
            Book.
          </p>
        ) : null}
        <p className="sc-copy">
          One Setting For Every Round. Nobody Picks A Difficulty; It Is Built Into The Payout. Any
          Loss, And Any Round You Do Not Cash Out, Pays At Least The Guaranteed Minimum Shown Before
          You Start.
        </p>
        <p className="sc-copy">
          Your Round Is Saved If You Leave. Reaching The Round Limit Books Your Win Automatically.
        </p>
        <p className="sc-copy">
          Chip Prizes Are Estimates Until Booked. A Fraction Of A Cent Is Rounded Up Or Down When
          The Win Is Booked.
        </p>
      </GamePanel>
      <GamePanel title="Round Proof" pill="Sealed" eyebrow="Sealed Before Play" foot="foot">
        <p className={`sc-copy ${styles.proofHash}`}>
          {open ? round.server_seed_hash : (ticket?.hash ?? 'Preparing Your Ticket')}
        </p>
        <label className={styles.seedField}>
          Your Seed
          <input
            className={styles.seedInput}
            value={seed}
            maxLength={64}
            disabled={busy || open || uncertain}
            onChange={(e) => setSeed(e.target.value)}
            onBlur={(e) => {
              if (!e.target.value.trim()) setSeed(randomClientSeed());
            }}
            aria-label="Your Seed"
          />
        </label>
        {round?.proof ? (
          <p className={`sc-copy ${styles.proofHash}`}>Completed Round: {round.server_seed_hash}</p>
        ) : null}
        {round?.proof ? (
          <button
            type="button"
            className={styles.back}
            onClick={async () => {
              try {
                const result = await verifyChoiceRound(round);
                if (mounted.current && !busyRef.current && currentRound.current?.id === round.id)
                  setVerified(result);
              } catch (e) {
                reportError(e, 'DiamondChoicePage.verify');
                if (mounted.current && !busyRef.current && currentRound.current?.id === round.id)
                  setVerified(false);
              }
            }}
          >
            Verify Revealed Outcome
          </button>
        ) : null}
        {verified !== null ? (
          <p className="sc-copy">
            {verified
              ? 'The Revealed Outcome And Chip Prize Match The Sealed Round.'
              : 'The Outcome Could Not Be Verified.'}
          </p>
        ) : null}
      </GamePanel>
      <GamePanel title="Recent Rounds" pill="Saved" foot="foot">
        {(state?.history ?? []).length === 0 ? (
          <p className="sc-copy">Your Completed Rounds Will Appear Here.</p>
        ) : (
          state?.history.map((item) => (
            <div className={styles.row} key={item.id}>
              <span className="sc-label">{historyRow(item)}</span>
              <span className="sc-ink--gold">{gameChips(item.payout_chips)} Chips</span>
            </div>
          ))
        )}
      </GamePanel>
      {receiptShowing && round && (
        <BonusCompletion
          key={round.id}
          clubId={clubId ?? ''}
          chips={round.payout_chips}
          // A crossing receipt never sings: the scene has already said what
          // happened, in its own beat. A lost Mines round is not a win either.
          silent={game === 'crossing' || round.status === 'lost'}
          eyebrow={
            round.status === 'lost'
              ? round.payout_chips > 0
                ? 'Guarantee Paid'
                : 'Round Over'
              : undefined
          }
          detail={
            game === 'mines'
              ? 'All Remaining Mines Have Been Revealed.'
              : round.status === 'lost'
                ? `Hit At Street ${round.picked.length}.`
                : `${bookedAt === null ? 'Your Win Is Booked.' : `Street ${picks} At ${bookedAt}`}${roadEnded === null ? '' : `; ${roadEnded}`}.`
          }
        />
      )}
    </div>
  );
}
