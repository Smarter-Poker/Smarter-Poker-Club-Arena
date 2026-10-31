import React, { useLayoutEffect, useRef, useState } from 'react';
import SeatSlot, { type Card } from '../../../src/components/table/SeatSlot';
import CommunityCards from '../../../src/components/table/CommunityCards';
import DealerButton from '../../../src/components/table/DealerButton';
import { seatLayoutFor } from '../../../src/lib/tableSeatGeometry';
import {
  boardCardWidthPx,
  tabledCardWidthPx,
  fitSeatToViewport,
  portraitTableTransform,
  portraitBoardWidthOfFeltPct,
  seatPodPx,
  betChipOffsetPx,
  chipCollectOffsetPx,
} from '../../../src/components/table/tableGeometry';
import { useProtectedCardLayout } from '../../../src/hooks/useProtectedCardLayout';
import BadBeatJackpot from '../../../src/components/table/BadBeatJackpot';
import ActionPanel from '../../../src/components/table/ActionPanel';
import PreActionBar from '../../../src/components/table/PreActionBar';
import PotDisplay from '../../../src/components/table/PotDisplay';
import HeroVpipTracker from '../../../src/components/table/HeroVpipTracker';
import PreviousHandCard from '../../../src/components/table/PreviousHandCard';
import TableHUD from '../../../src/components/table/TableHUD';
import TimebankCounter from '../../../src/components/table/TimebankCounter';
import RabbitHunt from '../../../src/components/table/RabbitHunt';
import lobbyArt from '../../../src/assets/lobby-button.webp';
import brandLogo from '../../../src/assets/smarter-poker-letter-logo.png';
import skin from '../../../src/assets/tables/skin_carbon_red.png';
export function Review() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 300, h: 650 });
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [handRevision, setHandRevision] = useState(0);
  useLayoutEffect(() => {
    const advance = () => setLayoutRevision((revision) => revision + 1);
    const nextHand = () => setHandRevision((revision) => revision + 1);
    document.addEventListener('fixture-runout', advance);
    document.addEventListener('fixture-next-hand', nextHand);
    return () => {
      document.removeEventListener('fixture-runout', advance);
      document.removeEventListener('fixture-next-hand', nextHand);
    };
  }, []);
  const [armed, setArmed] = useState<'fold' | 'check' | 'call' | 'callAny' | null>(null);
  const action = document.documentElement.dataset.action || 'preflop';
  const spectator = document.documentElement.dataset.spectator === 'true';
  const tournament = document.documentElement.dataset.tournament === 'true';
  const heroCards = Number(document.documentElement.dataset.cards || 4);
  const n = Number(
    document.documentElement.dataset.seats || new URLSearchParams(location.search).get('seats') || 9
  );
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) =>
      setSize({ w: e.contentRect.width, h: e.contentRect.height })
    );
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, []);
  useProtectedCardLayout(
    ref,
    JSON.stringify([size, layoutRevision]),
    `fixture:${4283505 + handRevision}`
  );
  const jackpot = document.documentElement.dataset.jackpot || 'mini';
  const revealed = document.documentElement.dataset.revealed !== 'false';
  // A tabled PLO6 hand at every seat (Dan 2026-10-22: a player could not see
  // the PLO6 hand he lost to).
  const villainCards = Number(document.documentElement.dataset.villainCards || 2);
  const villainHand = (
    villainCards > 2
      ? [
          { rank: 'A', suit: 'hearts' },
          { rank: 'A', suit: 'diamonds' },
          { rank: 'Q', suit: 'clubs' },
          { rank: 'J', suit: 'hearts' },
          { rank: '9', suit: 'diamonds' },
          { rank: '8', suit: 'clubs' },
        ].slice(0, villainCards)
      : [
          { rank: 'K', suit: 'spades' },
          { rank: '4', suit: 'spades' },
        ]
  ) as Card[];
  const width = innerWidth;
  const markerSize = {
    ...size,
    railBets: width <= 480,
    portraitTags: width <= 768 && innerHeight > innerWidth,
    portraitTaper: spectator ? 0 : undefined,
  };
  const seats = seatLayoutFor(n).map((p) =>
    fitSeatToViewport(
      p,
      { ...size, portraitTaper: spectator ? 0 : undefined },
      width,
      seatPodPx(width, p.y === 100 && !spectator, size.w, { seats: n, canvasHeightPx: size.h }),
      ref.current?.getBoundingClientRect().left,
      n
    )
  );
  const cards = [
    { rank: 'K', suit: 'spades' },
    { rank: '4', suit: 'spades' },
    { rank: '6', suit: 'clubs' },
    { rank: '6', suit: 'spades' },
    { rank: 'J', suit: 'hearts' },
  ] as Card[];
  return (
    <div className="multi-table-page">
      <div className="multi-table-page__tab-bar-wrapper">
        <div className="table-tab-bar">
          <button className="table-tab-bar__tab table-tab-bar__tab--active">NLH 1/2</button>
        </div>
      </div>
      <div
        className="multi-table-page__container"
        style={{
          transform: document.documentElement.dataset.swipe === 'true' ? 'translateX(0px)' : 'none',
        }}
      >
        <div className="multi-table-page__table-slot multi-table-page__table-slot--active">
          <div
            className={
              tournament
                ? 'table-page table-page--embedded table-page--tournament'
                : 'table-page table-page--embedded'
            }
            data-seats={n}
            data-hero={spectator ? 'false' : 'true'}
            data-hero-action={action === 'active' ? 'active' : 'waiting'}
            data-bbj-mini={jackpot === 'mini' ? '1' : '0'}
            style={{ background: '#080808' }}
          >
            <button className="mtp-lobby-btn" style={{ position: 'fixed', top: 0, right: 0 }}>
              <img src={lobbyArt} style={{ width: '100%', height: '100%' }} />
            </button>
            <button className="chat-collapsed" style={{ top: 50, bottom: 'auto' }}>
              <img
                className="chat-collapsed__icon-img"
                src="https://kuklfnapbkmacvwxktbh.supabase.co/storage/v1/object/public/assets/buttons/black/icon-chat.webp"
              />
            </button>
            <TableHUD
              bottomLeft={
                <div className="hud-bl-row">
                  <PreviousHandCard handNumber={4283504} />
                  {revealed ? (
                    <RabbitHunt
                      isAvailable
                      cardsAvailable={2}
                      userId={null}
                      onReveal={async () => ({ success: false, error: 'Fixture Does Not Charge' })}
                    />
                  ) : (
                    <TimebankCounter count={4} />
                  )}
                </div>
              }
            />
            {jackpot !== 'none' && (
              <BadBeatJackpot
                amount={33073}
                miniAmount={jackpot === 'mini' ? 425 : null}
                qualifyingHand="Quads"
              />
            )}
            <div className="table-container">
              <div
                className="table-scaler"
                ref={ref}
                style={
                  {
                    '--table-w': `${size.w}px`,
                    '--table-h': `${size.h}px`,
                    '--sp-tabled-card-w': `${tabledCardWidthPx(size.w, width, width <= 480 && size.h > size.w && !spectator, n, innerHeight > innerWidth)}px`,
                    '--sp-board-card-w': `${boardCardWidthPx(size.w, width, width <= 480 && size.h > size.w && !spectator)}px`,
                    '--sp-taper-board-width': `${portraitBoardWidthOfFeltPct(spectator ? 0 : undefined)}%`,
                    '--sp-table-taper': portraitTableTransform({
                      ...size,
                      portraitTaper: spectator ? 0 : undefined,
                    }),
                  } as any
                }
              >
                <img className="table-art" src={skin} />
                <div className="table-surface">
                  <div className="community-area">
                    <CommunityCards cards={cards} stage="river" playSounds={false} />
                  </div>
                  <div className="table-brand">
                    <img className="table-brand__logo" src={brandLogo} />
                    <div className="table-brand__meta">
                      <span className="table-brand__line table-brand__line--identity">
                        <span className="table-brand__club">
                          <span className="table-brand__club-name">Shark Club</span>{' '}
                          <span className="table-brand__union">· Midway Union</span>
                        </span>
                      </span>
                      <span className="table-brand__line table-brand__line--level">
                        <span className="table-brand__game">Madness PLO4 1/2 + BB Ante</span>
                      </span>
                      <span className="table-brand__line table-brand__line--hand">
                        Hand #4283505
                      </span>
                      <span className="table-brand__line table-brand__line--bomb">
                        Bomb Pot In 8:51
                      </span>
                    </div>
                  </div>
                </div>
                <div className="pot-area">
                  <PotDisplay mainPot={82.01} bigBlind={2} />
                </div>
                {seats.map((p, i) => {
                  const pod = seatPodPx(width, i === 0 && !spectator, size.w, {
                    seats: n,
                    canvasHeightPx: size.h,
                  });
                  const bet = betChipOffsetPx(p, markerSize, pod);
                  const collect = chipCollectOffsetPx(p, markerSize, pod);
                  return (
                    <div
                      key={i}
                      className={`seat-wrapper${i === 0 && !spectator ? ' seat-wrapper--hero' : ''}${p.y < 20 && !tournament ? ' seat-wrapper--top' : ''}${p.y < 20 ? ' seat-wrapper--cap' : ''}`}
                      style={
                        {
                          left: `${p.x}%`,
                          top: `${p.y}%`,
                          '--bet-offset-x': `${bet.x}px`,
                          '--bet-offset-y': `${bet.y}px`,
                          '--collect-dx': `${collect.x}px`,
                          '--collect-dy': `${collect.y}px`,
                        } as any
                      }
                    >
                      <SeatSlot
                        seatNumber={i + 1}
                        player={{
                          id: `p${i}`,
                          name: [
                            'KingFish',
                            'draw888',
                            'YoungDan',
                            'LOUAce',
                            'CHIMania',
                            'Big Blind',
                            'slc_elena',
                            'TonySr',
                            'Burls',
                          ][i],
                          avatar: `https://smarter.poker/avatars/table/${document.documentElement.dataset.avatar || 'vip_wolf@2x.webp'}`,
                          stack:
                            document.documentElement.dataset.allIn === 'true' && i % 3 === 0
                              ? 0
                              : 93.23,
                          status:
                            document.documentElement.dataset.allIn === 'true' && i % 3 === 0
                              ? 'all_in'
                              : 'active',
                          holeCards:
                            i === 0
                              ? [...cards, { rank: '10', suit: 'diamonds' }].slice(0, heroCards)
                              : villainHand,
                          showCards:
                            (i === 0 && !spectator) ||
                            (revealed &&
                              // A PLO6 showdown tables three opponents' hands, as an
                              // all-in hand does, spread round the ring.
                              (document.documentElement.dataset.showAll === 'true' ||
                                villainCards <= 2 ||
                                [1, Math.floor(n / 2), n - 1].includes(i))),
                          isHero: i === 0 && !spectator,
                        }}
                        position={i === 1 ? 'SB' : null}
                        isActive={false}
                        lastAction={revealed && i % 3 === 0 ? 'all_in' : 'call'}
                        lastBetAmount={
                          /* data-bets="0,3,5" bets only those chairs; absent, every chair bets. */
                          document.documentElement.dataset.bets === undefined ||
                          document.documentElement.dataset.bets.split(',').map(Number).includes(i)
                            ? 120
                            : 0
                        }
                        bigBlind={2}
                      />
                    </div>
                  );
                })}
                <HeroVpipTracker
                  tableId="00000000-0000-4000-8000-000000000001"
                  heroSeated={!spectator}
                  isTournament={false}
                  handNumber={4283505}
                  heroPos={{ x: 50, y: 100 }}
                />
                <DealerButton
                  dealerVisualIndex={Number(document.documentElement.dataset.dealer ?? 2)}
                  seatPositions={seats}
                  isVisible={true}
                  playSounds={false}
                />
              </div>
            </div>
            <div className="action-panel-wrapper">
              {spectator ? (
                <div className="spectator-footer-bar">
                  <span className="spectator-footer-bar__label">Spectating</span>
                </div>
              ) : action === 'active' ? (
                <ActionPanel
                  canFold
                  canCheck
                  canCall={false}
                  canRaise
                  canAllIn
                  callAmount={0}
                  minRaise={4}
                  maxRaise={398}
                  pot={26}
                  bigBlind={2}
                  onAction={() => undefined}
                  isMyTurn
                />
              ) : (
                <PreActionBar
                  canCheck={action !== 'facing-bet'}
                  currentBet={action === 'facing-bet' ? 20 : 0}
                  isMyTurn={false}
                  preAction={armed}
                  onPreActionChange={setArmed}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
