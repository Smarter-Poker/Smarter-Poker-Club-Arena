import { pendingBonus } from '../services/diamondBonusRecovery';
import { useBonusBudget } from '../hooks/useBonusBudget';
import DiamondSpinsTabs from '../components/games/DiamondSpinsTabs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { DeckConsole } from '../components/console/DeckConsole';
import { SpadeConsole } from '../components/console/SpadeConsole';
import BonusSetup from '../components/games/BonusSetup';
import TodayLine from '../components/games/TodayLine';
import SealedPrize from '../components/games/SealedPrize';
import { useGameCooldown } from '../hooks/useGameCooldown';
import { bonusTotal, gameChips, validSpinAmount } from '../utils/bonusGameBudget';
import { DiamondBonusService, BonusRefusal } from '../services/DiamondBonusService';
import ChoiceScene from '../components/games/ChoiceScene';
import {
  DiamondChoiceService,
  parseChoiceRound,
  type ChoiceRound,
  type ChoiceState,
} from '../services/DiamondChoiceService';
import { supabase } from '../lib/supabase';
import {
  MINE_COUNTS,
  ROAD_LADDERS,
  roadSurvives,
  verifyChoiceRound,
  type ChoiceGame,
  type RoadRisk,
} from '../utils/diamondChoiceMath';
import { randomClientSeed } from '../utils/wheelFairness';
import { compactChips } from '../utils/format';
import { multiplierLabel } from '../utils/diamondGamesFairness';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { triggerHaptic } from '../services/HapticService';
import '../components/console/SpadeConsole.css';
import styles from './diamondGames.module.css';

interface Ticket {
  id: string;
  hash: string;
}
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
  const [state, setState] = useState<ChoiceState | null>(null);
  const [round, setRound] = useState<ChoiceRound | null>(null);
  const [mode, setMode] = useState(game === 'mines' ? '5' : 'steady');
  const [budget, setBudget] = useBonusBudget(clubId, game);
  const bet = bonusTotal(budget);
  const [seed, setSeed] = useState(randomClientSeed);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [waitSeconds, setWaitSeconds] = useGameCooldown();
  const mounted = useRef(true),
    busyRef = useRef(false),
    generation = useRef(0);
  const currentRound = useRef(round);
  currentRound.current = round;
  const uncertainTicket = useRef<string | null>(null);
  const heldStart = useRef<Parameters<typeof DiamondBonusService.start>[0] | null>(null);
  const title = game === 'mines' ? 'Diamond Mines' : 'Donkey Crossing';

  const load = useCallback(
    async (id: string) => {
      const g = ++generation.current;
      const next = await DiamondChoiceService.state(id, game, mode, bet);
      if (!mounted.current || generation.current !== g) return;
      setState(next);
      setWaitSeconds(next.seconds_until_next);
      if (next.open_round) {
        setRound(next.open_round);
        setMode(next.open_round.mode);
        setBudget((current) =>
          bonusTotal(current) === next.open_round!.bet_diamonds
            ? current
            : {
                base:
                  next.open_round!.bet_diamonds > 2500
                    ? next.open_round!.bet_diamonds / 2
                    : next.open_round!.bet_diamonds,
                doubled: next.open_round!.bet_diamonds > 2500,
                denomination: 1,
              }
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
        else if (!current && next.history.length) setRound(next.history[0]);
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
          heldStart.current = pending;
          uncertainTicket.current = pending.commitId;
          setBudget(pending.budget);
          setUncertain(true);
          setError('Check Your Saved Round Before Starting Another.');
        }
        await load(id);
      } catch (e) {
        reportError(e, 'DiamondChoicePage.load');
        if (!cancelled) setError('The Game Could Not Be Loaded. Try Again.');
      }
    })();
    return () => {
      cancelled = true;
      mounted.current = false;
      generation.current++;
    };
  }, [clubId, user?.id, load, game, setBudget]);

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
      typeof value.server_seed_hash !== 'string'
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
    newTicket().catch((e) => {
      reportError(e, 'DiamondChoicePage.ticket');
      if (!cancelled) setError('The Game Ticket Could Not Be Loaded. Refresh To Try Again.');
    });
    return () => {
      cancelled = true;
    };
  }, [state?.available, round?.status, ticket, uncertain, newTicket]);

  const refresh = async () => {
    if (!uuid || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (heldStart.current) {
        const recovered = parseChoiceRound(
          await DiamondBonusService.start(heldStart.current, user?.id ?? '')
        );
        if (!mounted.current) return;
        setRound(recovered);
        heldStart.current = null;
        uncertainTicket.current = null;
        setUncertain(false);
        setTicket(null);
      }
      await load(uuid);
      if (mounted.current) setError(null);
    } catch (e) {
      reportError(e, 'DiamondChoicePage.refresh');
      if (mounted.current) {
        setError(
          e instanceof BonusRefusal ? e.message : 'The Round Could Not Be Checked. Try Again.'
        );
        if (e instanceof BonusRefusal) {
          heldStart.current = null;
          uncertainTicket.current = null;
          setUncertain(false);
        }
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const start = async () => {
    if (!uuid || !ticket || !state || busyRef.current || uncertain) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setVerified(null);
    uncertainTicket.current = ticket.id;
    heldStart.current = {
      clubId: uuid,
      game,
      mode,
      budget,
      commitId: ticket.id,
      seed,
      maxSteps: state.max_steps,
    };
    try {
      const next = parseChoiceRound(
        await DiamondBonusService.start(
          {
            clubId: uuid,
            game,
            mode,
            budget,
            commitId: ticket.id,
            seed,
            maxSteps: state.max_steps,
          },
          user?.id ?? ''
        )
      );
      if (!mounted.current) return;
      setRound(next);
      heldStart.current = null;
      setTicket(null);
      uncertainTicket.current = null;
      setUncertain(false);
      triggerHaptic('light');
      await load(uuid);
    } catch (e) {
      reportError(e, 'DiamondChoicePage.start');
      if (mounted.current) {
        if (e instanceof BonusRefusal) {
          heldStart.current = null;
          uncertainTicket.current = null;
        }
        setUncertain(!(e instanceof BonusRefusal));
        setError(e instanceof BonusRefusal ? e.message : 'Check Your Round Before Trying Again.');
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const act = async (action: 'pick' | 'cashout', cell: number | null) => {
    if (!uuid || !round || round.status !== 'open' || busyRef.current || uncertain) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setVerified(null);
    try {
      const next = await DiamondChoiceService.act(round.id, action, cell, round.picked.length);
      if (!mounted.current) return;
      setRound(next);
      triggerHaptic(next.status === 'lost' ? 'heavy' : 'light');
      await load(uuid);
    } catch (e) {
      reportError(e, 'DiamondChoicePage.act');
      if (mounted.current) {
        setUncertain(true);
        setError('Check Your Round To See The Confirmed Result.');
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const open = round?.status === 'open';
  const picks = round?.picked.length ?? 0;
  const prizes = open ? round.prizes : (state?.prizes ?? []);
  const prize = open && picks > 0 ? prizes[picks - 1] : prizes[0];
  const ladder = ROAD_LADDERS[(round?.mode ?? mode) as RoadRisk];
  const roadEnd =
    game === 'crossing' && round?.proof && ladder
      ? ladder.filter((target) => roadSurvives(BigInt(round.proof!.road_roll), target)).length
      : null;
  const roadMultiplier = roadEnd !== null && roadEnd > 0 ? ladder[roadEnd - 1] : 0;
  const payableRoadEnd = Math.min(roadEnd ?? 0, round?.max_steps ?? 0);
  const blocked =
    !validSpinAmount(budget.base) ||
    !state?.available ||
    state.frozen ||
    !state.is_member ||
    state.max_steps < 1 ||
    state.rounds_today >= state.daily_limit ||
    waitSeconds > 0 ||
    state.diamonds < bet;
  const status = uncertain
    ? 'Check Round'
    : busy
      ? 'One Moment'
      : open
        ? 'In Play'
        : round?.status === 'cashed'
          ? 'Win Booked'
          : round?.status === 'lost'
            ? 'Round Over'
            : 'Ready';
  const modeLabel =
    game === 'mines' ? `${mode} Mines` : mode.charAt(0).toUpperCase() + mode.slice(1);
  const cycleMode = () => {
    const modes = game === 'mines' ? MINE_COUNTS.map(String) : Object.keys(ROAD_LADDERS);
    setMode(modes[(modes.indexOf(mode) + 1) % modes.length]);
  };
  const cashLabel = open && picks > 0 ? 'Book The Win' : 'Refresh';
  const phase = round?.status ?? 'idle';
  return (
    <div className={styles.page}>
      <button
        type="button"
        className={styles.back}
        onClick={() => navigate(`/clubs/${clubId}/diamond-games`)}
      >
        ‹ Diamond Spins
      </button>
      <DiamondSpinsTabs clubId={clubId ?? ''} />
      {!open && (
        <BonusSetup
          budget={budget}
          onChange={setBudget}
          diamonds={state?.diamonds ?? null}
          disabled={busy || uncertain}
          clubId={clubId ?? ''}
        />
      )}
      <DeckConsole
        title={title}
        eyebrow="Diamond Spins"
        pill={status}
        pillInk={round?.status === 'cashed' ? 'green' : 'blue'}
        bays={[
          {
            label: game === 'mines' ? 'Mines' : 'Difficulty',
            value: modeLabel,
            onPress: cycleMode,
            disabled: busy || open || uncertain,
          },
          {
            label: 'Bet',
            value: compactChips(bet),
            disabled: true,
          },
          { label: game === 'mines' ? 'Revealed' : 'Street', value: String(picks), ink: 'silver' },
          {
            label: 'Chip Prize',
            value: prize === undefined ? 'N/A' : gameChips(prize),
            ink: 'gold',
          },
        ]}
        secondary={{
          label: uncertain ? 'Check Round' : cashLabel,
          onClick: () =>
            open && picks > 0 && !uncertain ? void act('cashout', null) : void refresh(),
          disabled: busy,
        }}
        primary={{
          label: open
            ? game === 'crossing'
              ? 'Cross Street'
              : 'Choose A Tile'
            : waitSeconds > 0
              ? `Ready In ${waitSeconds}s`
              : 'Start Round',
          onClick: () => (open ? void act('pick', picks) : void start()),
          disabled: busy || uncertain || (open ? game === 'mines' : blocked || !ticket),
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
          phase={phase}
          picked={round?.picked ?? []}
          mines={round?.proof?.mine_cells ?? null}
          roadEnd={roadEnd}
          busy={busy || uncertain}
          onPick={(cell) => void act('pick', cell)}
        />
        <div className={styles.readout} aria-live="polite">
          {error ? <p className="sc-copy sc-ink--red">{error}</p> : null}
          {round?.status === 'cashed' ? (
            <>
              <strong className="sc-ink--gold">{gameChips(round.payout_chips)} Chips Booked</strong>
              <p className="sc-copy">
                {game === 'mines'
                  ? 'All Remaining Mines Are Revealed. Your Win Is Saved.'
                  : roadEnd === 0
                    ? 'The Donkey Would Have Stopped Before Street 1.'
                    : `Would Have Reached Street ${roadEnd} At ${multiplierLabel(roadMultiplier)}.${roadEnd === ladder?.length ? ' The Final Street.' : ' The Next Street Was The Crash.'}${payableRoadEnd < (roadEnd ?? 0) ? ` Your Round Would Have Booked At Its Street ${payableRoadEnd} Limit First.` : ''}`}{' '}
                {game === 'crossing' && payableRoadEnd > 0 && round.proof ? (
                  <SealedPrize
                    serverSeed={round.proof.server_seed}
                    clientSeed={round.client_seed}
                    nonce={round.nonce}
                    betChips={round.bet_chips}
                    multiplierCents={ladder[payableRoadEnd - 1]}
                    roundingStep={payableRoadEnd}
                  />
                ) : null}
              </p>
            </>
          ) : round?.status === 'lost' ? (
            <p className="sc-copy">
              {game === 'mines'
                ? 'A Mine Ended This Round. All Mines Are Revealed.'
                : 'The Donkey Did Not Make This Crossing.'}{' '}
              No Chip Prize.
            </p>
          ) : (
            <p className="sc-copy">
              {open
                ? game === 'mines'
                  ? 'Reveal A Tile Or Book The Win.'
                  : 'Cross The Next Street Or Book The Win.'
                : !state
                  ? 'Loading Your Game'
                  : blocked
                    ? state.diamonds < bet
                      ? 'Not Enough Diamonds For This Bet'
                      : !state.is_member
                        ? 'Join The Club To Play'
                        : !state.available
                          ? 'This Game Is Not Open Here Yet'
                          : 'This Bet Is Not Available Right Now'
                    : `${compactChips(bet)} Diamonds To Play. ${state.max_steps} ${game === 'mines' ? 'Safe Picks' : 'Streets'} In This Round.`}
            </p>
          )}
        </div>
      </DeckConsole>
      <SpadeConsole
        title="Your Game"
        pill="Rules"
        eyebrow={`${compactChips(state?.diamonds ?? 0)} Diamonds`}
        foot="foot"
      >
        <p className="sc-copy">
          {game === 'mines'
            ? 'Pick Hidden Gems On The Board. A Mine Ends The Round. Book The Win After Any Safe Pick; The Remaining Mines Will Then Be Revealed.'
            : 'Guide The Donkey Across The Road. Each Safe Crossing Raises Your Prize. Book The Win Before A Collision Ends The Round. Traffic Animation Does Not Change The Outcome.'}
        </p>
        <p className="sc-copy">
          Your Round Is Saved If You Leave. Reaching The Round Limit Books Your Win Automatically.
        </p>
        {game === 'mines' ? (
          <p className="sc-copy">
            Chip Prizes Are Estimates Until Booked. A Fraction Of A Cent Is Rounded Up Or Down When
            The Win Is Booked.
          </p>
        ) : null}
      </SpadeConsole>
      <SpadeConsole title="Round Proof" pill="Sealed" eyebrow="Sealed Before Play" foot="foot">
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
                if (mounted.current) setVerified(result);
              } catch (e) {
                reportError(e, 'DiamondChoicePage.verify');
                if (mounted.current) setVerified(false);
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
      </SpadeConsole>
      <SpadeConsole title="Recent Rounds" pill="Saved" foot="foot">
        {(state?.history ?? []).length === 0 ? (
          <p className="sc-copy">Your Completed Rounds Will Appear Here.</p>
        ) : (
          state?.history.map((item) => (
            <div className={styles.row} key={item.id}>
              <span className="sc-label">
                {item.status === 'cashed' ? 'Win Booked' : 'Round Over'}
              </span>
              <span className="sc-ink--gold">{gameChips(item.payout_chips)} Chips</span>
            </div>
          ))
        )}
      </SpadeConsole>
    </div>
  );
}
