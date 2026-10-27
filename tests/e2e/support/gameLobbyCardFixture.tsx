import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import GameLobbyPanel from '../../../src/components/lobby/GameLobbyPanel';
import { cashEntry, tournamentEntry } from '../../../src/components/lobby/lobbyEntries';
import { ToastProvider } from '../../../src/components/common/Toast';
import { TickerRail } from '../../../src/components/tournament/TickerRail';
import { startingSoonItem } from '../../../src/components/tournament/tickerMessages';
const kind = document.documentElement.dataset.kind || 'cash';
const entry =
  kind === 'cash' || kind === 'cash-full'
    ? cashEntry({
        id: kind === 'cash-full' ? 'fixture-cash-full' : 'fixture-cash',
        name: 'Classic',
        game_variant: 'plo6',
        small_blind: 1,
        big_blind: 2,
        min_buy_in: 80,
        max_buy_in: 400,
        current_players: kind === 'cash-full' ? 6 : 4,
        max_players: 6,
        status: 'active',
      })
    : tournamentEntry(
        {
          id: 'fixture-event',
          name: 'Evening Classic',
          game_type: 'NLH',
          buy_in_amount: 10,
          buy_in_fee: 1,
          guaranteed_prize: kind === 'mtt' ? 1000 : 0,
          start_time: new Date(Date.now() + 3600000).toISOString(),
          status: 'REGISTERING',
          current_players: 1,
          max_players: kind === 'spin' ? 3 : kind === 'sng' ? 2 : 180,
          starting_chips: 10000,
          variant: kind,
          format_contract: kind === 'spin' ? 'spin-v1' : kind === 'sng' ? 'sng-v1' : 'mtt-v1',
        } as any,
        kind as any
      );
const noop = () => undefined;
function Fixture() {
  const [open, setOpen] = useState(true);
  const [waitlisted, setWaitlisted] = useState(false);
  const [waitlistCalls, setWaitlistCalls] = useState<{ tableId: string; joining: boolean }[]>([]);
  const [joinTableCalls, setJoinTableCalls] = useState<string[]>([]);
  return (
    <>
      <output hidden data-testid="fixture-waitlist-calls">
        {JSON.stringify(waitlistCalls)}
      </output>
      <output hidden data-testid="fixture-join-table-calls">
        {JSON.stringify(joinTableCalls)}
      </output>
      {createPortal(
        <TickerRail
          items={[
            startingSoonItem({
              id: 'fixture-tournament',
              name: 'Evening Classic',
              startsAt: Date.now() + 180000,
              clubId: 'fixture',
              buyIn: 10,
              buyInFee: 1,
              registered: 18,
              isRegistered: false,
            }),
          ]}
          now={Date.now()}
          top={44}
          appearance={{
            backgroundColor: '#0b1a33',
            textColor: '#f5fbff',
            accentColor: '#00d4ff',
            fontFamily: 'System',
            speedSeconds: 24,
          }}
          onOpen={() => {
            document.body.dataset.tickerOpened = 'true';
          }}
          onDismiss={noop}
        />,
        document.getElementById('ticker-root')!
      )}
      <button type="button" style={{ marginTop: 80 }} onClick={() => setOpen(true)}>
        Open Game Lobby
      </button>
      {open && (
        <GameLobbyPanel
          entry={entry}
          clubId="fixture"
          currentUserId={kind === 'cash-full' ? 'fixture-user' : null}
          waitlisted={waitlisted}
          seated={false}
          registered={false}
          busy={false}
          onClose={() => setOpen(false)}
          onJoinTable={(tableId) => setJoinTableCalls((calls) => [...calls, tableId])}
          onWaitlistToggle={(tableId, joining) => {
            setWaitlistCalls((calls) => [...calls, { tableId, joining }]);
            setWaitlisted(joining);
          }}
          onRegister={noop}
          onUnregister={noop}
          onSpinJoin={noop}
        />
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <ToastProvider>
      <Fixture />
    </ToastProvider>
  </MemoryRouter>
);
