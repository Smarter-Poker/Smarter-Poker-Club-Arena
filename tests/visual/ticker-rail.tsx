/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE RAIL, ON A SCREEN, WITH REAL COMPONENTS (2026-09-13)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan sent a photograph of the live bar and it carried three defects that the
 * whole unit suite could not see: a space eaten by a flex box, a label sitting
 * on top of a scrolling message, and a field name in front of a label. Every
 * one of them is a LAYOUT fact, and `textContent` has no opinion about layout.
 *
 * So there is a place to look now. This mounts the real TickerRail, the real
 * stylesheet and the real message composers - no mocks, no copies - over a felt,
 * at the sizes players actually use. `tests/visual/ticker-rail.spec.ts` drives
 * it and writes the pictures.
 *
 * It is NOT part of the app build: Vite bundles from index.html and this entry
 * is reachable only from the dev server by path.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TickerRail } from '../../src/components/tournament/TickerRail';
import {
  guaranteeItem,
  operatorItem,
  overlayItem,
  registrationClosingItem,
  startingSoonItem,
  tableOpeningItem,
  type TickerItem,
} from '../../src/components/tournament/tickerMessages';
import '../../src/styles/club-engine.css';

const NOW = Date.now();

const APPEARANCE = {
  backgroundColor: '#0b1a33',
  textColor: '#f5fbff',
  accentColor: '#00d4ff',
  fontFamily: 'Rajdhani',
  speedSeconds: 24,
};

/** The exact line from the photograph, so the fix can be seen against it. */
const fromThePhotograph = startingSoonItem({
  id: 'p1',
  name: 'Sunday $200 Deep Stack',
  startsAt: NOW + 19_000,
  clubId: 'club-1',
  buyIn: 180,
  buyInFee: 20,
  registered: 81,
  isRegistered: false,
});

const freeroll = startingSoonItem({
  id: 'p2',
  name: '$100 Freeroll',
  startsAt: NOW + 19_000,
  clubId: 'club-1',
  buyIn: 0,
  buyInFee: 0,
  registered: 271,
  isRegistered: false,
});

const overlay = overlayItem({
  id: 'o1',
  name: 'Sunday Slam',
  tier: 'live',
  overlay: 8400,
  guarantee: 20000,
  prizePool: 9000,
  entered: 90,
  entriesToClose: 42,
  startsAt: NOW - 600_000,
});

const urgent = startingSoonItem({
  id: 'p3',
  name: 'Nightly Turbo',
  startsAt: NOW + 41_000,
  clubId: 'club-1',
  buyIn: 9,
  buyInFee: 2,
  registered: 24,
  isRegistered: false,
});

const operational: TickerItem[] = [
  registrationClosingItem('t9', 'Deep Stack Turbo', NOW + 252_000),
  guaranteeItem('t3', 'Big Sunday', 20000, 12, NOW + 3_600_000),
  tableOpeningItem('tbl1', 'Table 4', 'plo4', NOW),
];

/** Every state the bar has, stacked, each labelled. */
const SCENES: Array<{ label: string; items: TickerItem[] }> = [
  {
    label: 'Starting soon - two events, the photograph line first',
    items: [fromThePhotograph, freeroll],
  },
  { label: 'Overlay - money takes the bar from a countdown', items: [overlay] },
  { label: 'Under a minute - the digits go urgent, nothing else moves', items: [urgent] },
  { label: 'Operational lane - three sources joined by drawn pips', items: operational },
  {
    label: 'Club update - an operator speaking, no clock',
    items: [operatorItem('custom_messages', 0, 'Freeroll At 8 PM, All Members Welcome')],
  },
];

function Harness() {
  return (
    <>
      {SCENES.map((scene, i) => (
        <div key={scene.label} style={{ position: 'relative', height: 92 }}>
          <div className="harness-label" style={{ top: i * 92 + 66 }}>
            {scene.label}
          </div>
          {/* `top` is what the real container passes from useTopChromeOffset. */}
          <TickerRail
            items={scene.items}
            now={NOW}
            top={i * 92}
            appearance={APPEARANCE}
            onOpen={() => {}}
            onDismiss={() => {}}
          />
        </div>
      ))}
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>
);
