import React, { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import SeatSlot, { type Card } from '../../../src/components/table/SeatSlot';
import CommunityCards from '../../../src/components/table/CommunityCards';
import DealerButton from '../../../src/components/table/DealerButton';
import { seatLayoutFor } from '../../../src/lib/tableSeatGeometry';
import {
  fitSeatToViewport,
  portraitTableTransform,
  portraitBoardWidthOfFeltPct,
  seatPodPx,
  betChipOffsetPx,
  chipCollectOffsetPx,
} from '../../../src/components/table/tableGeometry';
import { useProtectedCardLayout } from '../../../src/hooks/useProtectedCardLayout';
import BadBeatJackpot from '../../../src/components/table/BadBeatJackpot';
import TableHUD from '../../../src/components/table/TableHUD';
import TimebankCounter from '../../../src/components/table/TimebankCounter';
import RabbitHunt from '../../../src/components/table/RabbitHunt';
import lobbyArt from '../../../src/assets/lobby-button.webp';
import skin from '../../../src/assets/tables/skin_carbon_red.png';
import { ToastProvider } from '../../../src/components/common/Toast';
function Review() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 300, h: 650 });
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
  useProtectedCardLayout(ref, JSON.stringify(size));
  const jackpot = document.documentElement.dataset.jackpot || 'mini';
  const revealed = document.documentElement.dataset.revealed !== 'false';
  const width = innerWidth;
  const markerSize = { ...size, railBets: width <= 480 };
  const seats = seatLayoutFor(n).map((p) =>
    fitSeatToViewport(
      p,
      size,
      width,
      seatPodPx(width, p.y === 100, size.w),
      ref.current?.getBoundingClientRect().left
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
      <div
        className="table-page table-page--embedded"
        data-seats={n}
        data-hero="true"
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
              <TimebankCounter count={4} />
              <RabbitHunt
                isAvailable
                cardsAvailable={2}
                userId={null}
                onReveal={async () => ({ success: false, error: 'Fixture Does Not Charge' })}
              />
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
                '--sp-taper-board-width': `${portraitBoardWidthOfFeltPct()}%`,
                '--sp-table-taper': portraitTableTransform(size),
              } as any
            }
          >
            <img className="table-art" src={skin} />
            <div className="table-surface">
              <div className="community-area">
                <CommunityCards cards={cards} stage="river" playSounds={false} />
              </div>
              <div className="table-brand">Smarter.Poker</div>
            </div>
            <div className="pot-area">
              <div className="pot-display">Pot 82.01</div>
            </div>
            {seats.map((p, i) => {
              const pod = seatPodPx(width, i === 0, size.w);
              const bet = betChipOffsetPx(p, markerSize, pod);
              const collect = chipCollectOffsetPx(p, markerSize, pod);
              return (
                <div
                  key={i}
                  className={`seat-wrapper${i === 0 ? ' seat-wrapper--hero' : ''}${p.y < 20 ? ' seat-wrapper--top' : ''}`}
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
                      avatar: 'https://smarter.poker/avatars/table/vip_wolf@2x.webp',
                      stack: 93.23,
                      status: 'active',
                      holeCards: cards.slice(0, 2),
                      showCards: revealed,
                      isHero: i === 0,
                    }}
                    position={i === 1 ? 'SB' : null}
                    isActive={false}
                    lastAction={revealed && i % 3 === 0 ? 'all_in' : 'call'}
                    lastBetAmount={120}
                    bigBlind={2}
                  />
                </div>
              );
            })}
            <DealerButton
              dealerVisualIndex={2}
              seatPositions={seats}
              isVisible={true}
              playSounds={false}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <Review />
  </ToastProvider>
);
