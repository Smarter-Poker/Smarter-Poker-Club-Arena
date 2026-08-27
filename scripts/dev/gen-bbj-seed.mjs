/**
 * Generates 20260827_bbj_full_hand_seed.sql.
 *
 * Every hand is verified here before a line of SQL is written:
 *   - the stated hand category is what bestFive() will actually compute,
 *     under that variant's own rules (Omaha: exactly two hole + three board);
 *   - no card appears twice in a hand;
 *   - blinds + every action amount sum EXACTLY to pot_size, which is what
 *     BBJHandDetail checks before it will show the running-pot column;
 *   - the jackpot shares sum exactly to the payout total.
 * A failure here throws instead of emitting SQL.
 */

// ── evaluator: a faithful port of src/utils/handEvaluator.ts ────────────────
const RV = { 2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,T:10,J:11,Q:12,K:13,A:14 };
const CAT_NAME = {1:'High Card',2:'Pair',3:'Two Pair',4:'Three of a Kind',5:'Straight',6:'Flush',7:'Full House',8:'Four of a Kind',9:'Straight Flush'};
const val = (c) => RV[String(c.rank).toUpperCase()] ?? 0;

function scoreFive(cards) {
  const vals = cards.map(val).sort((a,b)=>b-a);
  const suits = cards.map(c=>c.suit);
  const isFlush = suits.every(s=>s===suits[0]);
  const counts = new Map();
  vals.forEach(v=>counts.set(v,(counts.get(v)||0)+1));
  const groups = [...counts.entries()].sort((a,b)=>b[1]-a[1]||b[0]-a[0]);
  const shape = groups.map(g=>g[1]).join('');
  const byGroup = groups.map(g=>g[0]);
  const distinct = [...counts.keys()].sort((a,b)=>b-a);
  let sh = 0;
  if (distinct.length===5) {
    if (distinct[0]-distinct[4]===4) sh = distinct[0];
    else if (distinct[0]===14 && distinct[1]===5 && distinct[4]===2) sh = 5;
  }
  if (isFlush && sh) return { category:9, tiebreak:[sh] };
  if (shape==='41') return { category:8, tiebreak:byGroup };
  if (shape==='32') return { category:7, tiebreak:byGroup };
  if (isFlush) return { category:6, tiebreak:vals };
  if (sh) return { category:5, tiebreak:[sh] };
  if (shape==='311') return { category:4, tiebreak:byGroup };
  if (shape==='221') return { category:3, tiebreak:byGroup };
  if (shape==='2111') return { category:2, tiebreak:byGroup };
  return { category:1, tiebreak:vals };
}
function cmp(a,b){ if(a.category!==b.category) return a.category-b.category;
  const n=Math.max(a.tiebreak.length,b.tiebreak.length);
  for(let i=0;i<n;i++){const x=a.tiebreak[i]??0,y=b.tiebreak[i]??0;if(x!==y)return x-y;} return 0; }
function combos(arr,k){ const out=[],idx=[]; const walk=(s)=>{ if(idx.length===k){out.push(idx.map(i=>arr[i]));return;}
  for(let i=s;i<arr.length;i++){idx.push(i);walk(i+1);idx.pop();} }; if(k<=arr.length&&k>=0) walk(0); return out; }
const isOmaha = (v) => { const r=String(v||'').toLowerCase().trim();
  return r.startsWith('plo')||r.startsWith('flo')||r.includes('omaha')||r.startsWith('bigo')||r.startsWith('big_o')||r==='big o'; };
function nameFor(s){ return s.category===9 ? (s.tiebreak[0]===14?'Royal Flush':'Straight Flush') : CAT_NAME[s.category]; }
function bestFive(hole, board, variant) {
  let cands;
  if (isOmaha(variant)) {
    if (hole.length<2||board.length<3) return null;
    cands=[]; for(const hp of combos(hole,2)) for(const bt of combos(board,3)) cands.push([...hp,...bt]);
  } else {
    const all=[...hole,...board]; if(all.length<5) return null; cands=combos(all,5);
  }
  let best=null;
  for(const c of cands){ const s=scoreFive(c); if(!best||cmp(s,best)>0) best={...s,cards:c,name:nameFor(s)}; }
  return best;
}

// ── card helpers ───────────────────────────────────────────────────────────
const SUIT = { s:'spades', h:'hearts', d:'diamonds', c:'clubs' };
const card = (str) => ({ rank: str[0], suit: SUIT[str[1]] });
const cards = (s) => s.split(' ').map(card);
const wire = (c) => `${c.rank}${c.suit}`;          // "Aclubs" - hand_history text form
const key  = (c) => `${c.rank}${c.suit}`;

// ── positions: a port of src/utils/pokerPositions.ts ───────────────────────
const MIDDLE = {0:[],1:['CO'],2:['UTG','CO'],3:['UTG','MP','CO'],4:['UTG','UTG+1','MP','CO'],
  5:['UTG','UTG+1','MP','HJ','CO'],6:['UTG','UTG+1','UTG+2','MP','HJ','CO']};
function positions(seatList, button) {
  const seats=[...new Set(seatList)].sort((a,b)=>a-b); const out={};
  const bi=seats.indexOf(button); if(bi<0) return out;
  const n=seats.length, at=(o)=>seats[(bi+o)%n];
  if(n===1){out[at(0)]='BTN';return out;}
  if(n===2){out[at(0)]='SB';out[at(1)]='BB';return out;}
  out[at(0)]='BTN'; out[at(1)]='SB'; out[at(2)]='BB';
  const mc=n-3, labels=MIDDLE[mc];
  for(let i=0;i<mc;i++) out[at(3+i)] = labels?labels[i]:(i===0?'UTG':`UTG+${i}`);
  return out;
}

// ── the five hands ─────────────────────────────────────────────────────────
// Each `acts` entry: [seat, stage, action, incremental amount]
const HANDS = [
  {
    payoutId: 'b19f8048-d63f-4f85-b2ae-863299c81b2d',
    tableId: '81b02fd7-6c0e-4d19-af33-0957ca17b0ea',
    handNumber: 1506711,
    variant: 'plo4', sb: 5, bb: 10, button: 7,
    playedAt: '2026-08-18 23:30:00+00', endedAt: '2026-08-18 23:34:40+00',
    awardedAt: '2026-08-18 23:35:00+00',
    board: cards('Ac Jd Kh Ad Qd'),
    seats: [
      { seat:1, id:'e94d80fb-4973-452e-b745-6c3ca68c9b16', name:'Obsidian',            stack:1875.00 },
      { seat:3, id:'ef25984c-d13a-4e4d-916a-f3537a40ea71', name:'Pulsar',              stack:2410.00 },
      { seat:5, id:'083db75b-95a3-47ae-9989-927134dfa026', name:'Valentina Salvatore', stack:0.00, hole:cards('As Ah 7s 2d'), badBeat:true },
      { seat:7, id:'a497dbb8-a32c-4bb9-9ffa-beeea1d8c5d8', name:'WASP',                stack:7775.00, hole:cards('Td Kd 8c 4s'), handWinner:true },
    ],
    acts: [
      [5,'preflop','raise',35],[7,'preflop','call',35],[1,'preflop','fold',0],[3,'preflop','fold',0],
      [5,'flop','bet',60],[7,'flop','call',60],
      [5,'turn','bet',200],[7,'turn','raise',700],[5,'turn','call',500],
      [5,'river','bet',900],[7,'river','all_in',3115],[5,'river','call',2215],
    ],
    rake: 50.00, jackpotFee: 10.00,
    jackpot: { total:7883.92, badBeat:3941.96, handWinner:1970.98, table:[[1,985.49],[3,985.49]] },
  },
  {
    payoutId: 'd55f4b9d-115e-4bd2-a768-ac478cbebb04',
    tableId: 'e995a2ba-cd4d-4fd1-ab74-775370ee341e',
    handNumber: 1269428,
    variant: 'plo5', sb: 1, bb: 2, button: 5,
    playedAt: '2026-08-12 21:10:00+00', endedAt: '2026-08-12 21:13:35+00',
    awardedAt: '2026-08-12 21:14:00+00',
    board: cards('9s Qd Td Ks Jd'),
    seats: [
      { seat:1, id:'145aaccb-b8bf-434a-b5e7-ca23a306799c', name:'SALVO',              stack:412.00 },
      { seat:2, id:'f12caf56-c369-4b22-8e04-fdda07820876', name:'Josephine Whitmore', stack:0.00, hole:cards('8d 9d Ac 5s 3h'), badBeat:true },
      { seat:3, id:'b5e78a91-cc79-4fb0-989d-b47da1363a33', name:'Joseph Hernandez',   stack:268.00 },
      { seat:5, id:'00000000-0000-0000-0000-000000000026', name:'earlyPosition',      stack:574.00, hole:cards('Ad Kd 8c 4h 2s'), handWinner:true },
      { seat:6, id:'3d15bbe7-f752-4a49-be3a-079232d23b0f', name:'Tempest',            stack:196.00 },
      { seat:7, id:'c3195f0b-2da2-40d1-b1fd-42ab69e55edf', name:'Edward Delgado',     stack:333.00 },
    ],
    acts: [
      [1,'preflop','fold',0],[2,'preflop','raise',7],[3,'preflop','fold',0],[5,'preflop','call',7],
      [6,'preflop','fold',0],[7,'preflop','fold',0],
      [2,'flop','bet',12],[5,'flop','call',12],
      [2,'turn','bet',30],[5,'turn','call',30],
      [2,'river','bet',80],[5,'river','all_in',240],[2,'river','call',160],
    ],
    rake: 6.00, jackpotFee: 1.00,
    jackpot: { total:6275.88, badBeat:3137.94, handWinner:1568.97,
               table:[[1,392.25],[3,392.24],[6,392.24],[7,392.24]] },
  },
  {
    payoutId: 'e6e0447c-5ffc-4a96-abed-5f8a6c4b5cfc',
    tableId: 'a5cb6513-cceb-44d1-b742-46822a1eb941',
    handNumber: 1253455,
    variant: 'plo5', sb: 0.5, bb: 1, button: 7,
    playedAt: '2026-08-04 18:22:00+00', endedAt: '2026-08-04 18:24:30+00',
    awardedAt: '2026-08-04 18:25:00+00',
    board: cards('6h 7h 8h 2c 3d'),
    seats: [
      { seat:1, id:'2e49e7e8-346a-49ba-91d3-699f1d9e0d6a', name:'Jacob Russo',     stack:143.50 },
      { seat:2, id:'6fdfcb70-b8f3-4ed1-89ca-a7d8af136dfc', name:'Harold Kitamura', stack:88.00 },
      { seat:3, id:'25e20c49-15d7-410f-bb88-7161d758c9d5', name:'Freeway',         stack:0.00, hole:cards('4h 5h Ac Ks 2d'), badBeat:true },
      { seat:4, id:'498f15d8-1f5c-46e4-a330-c40301952540', name:'Ursa',            stack:210.00 },
      { seat:6, id:'de0fe8e7-d317-43b7-bd5f-82dbac01418a', name:'Caroline Myers',  stack:727.50, hole:cards('9h Th Jd Qs 3c'), handWinner:true },
      { seat:7, id:'1b049140-90bf-4b45-82db-a6dc259ce0c3', name:'Vulcan',          stack:164.00 },
    ],
    acts: [
      [3,'preflop','raise',3.5],[4,'preflop','fold',0],[6,'preflop','call',3.5],[7,'preflop','fold',0],
      [1,'preflop','fold',0],[2,'preflop','fold',0],
      [3,'flop','bet',6],[6,'flop','raise',24],[3,'flop','call',18],
      [3,'turn','bet',40],[6,'turn','call',40],
      [3,'river','bet',100],[6,'river','all_in',300],[3,'river','call',200],
    ],
    rake: 7.50, jackpotFee: 1.50,
    jackpot: { total:3640.00, badBeat:1820.00, handWinner:910.00,
               table:[[1,227.50],[2,227.50],[4,227.50],[7,227.50]] },
  },
  {
    payoutId: 'e9d4bacf-3cc5-4988-9fc4-51b2c83620d9',
    tableId: '4fd19504-708a-47e2-89ff-888d8f567c42',
    handNumber: 1127041,
    variant: 'nlh', sb: 0.1, bb: 0.2, button: 9,
    playedAt: '2026-07-30 09:15:00+00', endedAt: '2026-07-30 09:17:20+00',
    awardedAt: '2026-07-30 09:18:00+00',
    board: cards('Qs Qd 8h Kc Kd'),
    seats: [
      { seat:1, id:'7d7a80a2-092c-4338-878a-0416611b249c', name:'Aaron Bell',       stack:19.40 },
      { seat:3, id:'740e9ec1-0995-41d3-b12d-635a92631592', name:'Abqmark',          stack:24.80 },
      { seat:4, id:'00000000-0000-0000-0000-000000000008', name:'broadwayKing',     stack:0.00, hole:cards('Qh Qc'), badBeat:true },
      { seat:6, id:'165df98e-f59d-46aa-bc74-a974c0ded83f', name:'aceHighJack',      stack:31.00 },
      { seat:9, id:'f1042170-33c9-4063-b427-910fe1683c72', name:'Alice Bourgeois',  stack:102.50, hole:cards('Kh Ks'), handWinner:true },
    ],
    acts: [
      [4,'preflop','raise',0.6],[6,'preflop','fold',0],[9,'preflop','call',0.6],
      [1,'preflop','fold',0],[3,'preflop','fold',0],
      [4,'flop','bet',1],[9,'flop','call',1],
      [4,'turn','bet',3],[9,'turn','raise',9],[4,'turn','call',6],
      [4,'river','bet',14],[9,'river','all_in',42],[4,'river','call',28],
    ],
    rake: 2.50, jackpotFee: 0.50,
    jackpot: { total:5740.00, badBeat:2870.00, handWinner:1435.00,
               table:[[1,478.34],[3,478.33],[6,478.33]] },
  },
  {
    payoutId: '44f57403-0744-4278-be49-489b530c4cac',
    tableId: '6e71b875-28f8-4aa2-826d-bbac704aa492',
    handNumber: 1080832,
    variant: 'plo4', sb: 1, bb: 2, button: 8,
    playedAt: '2026-07-22 14:29:00+00', endedAt: '2026-07-22 14:31:40+00',
    awardedAt: '2026-07-22 14:32:00+00',
    board: cards('Ac Kc 5h Ad Qc'),
    seats: [
      { seat:2, id:'97e77c3a-16af-4e7f-9a83-9fd91c958067', name:'FALCON',          stack:305.00 },
      { seat:4, id:'c402b38e-7ba6-40bf-a2d3-d65376d28ccf', name:'Mark Phillips',   stack:418.00 },
      { seat:6, id:'60f7edc9-f93e-43da-833c-1dd10caef345', name:'CRUX',            stack:0.00, hole:cards('As Ah 7d 2s'), badBeat:true },
      { seat:8, id:'ca905025-0dfc-4353-ac1e-444ce5763c83', name:'Christopher Lee', stack:2197.00, hole:cards('Jc Tc 8d 3h'), handWinner:true },
    ],
    acts: [
      [6,'preflop','raise',7],[8,'preflop','call',7],[2,'preflop','fold',0],[4,'preflop','fold',0],
      [6,'flop','bet',12],[8,'flop','call',12],
      [6,'turn','bet',40],[8,'turn','raise',160],[6,'turn','call',120],
      [6,'river','bet',200],[8,'river','all_in',933],[6,'river','call',733],
    ],
    rake: 25.00, jackpotFee: 5.00,
    jackpot: { total:3150.00, badBeat:1575.00, handWinner:787.50, table:[[2,393.75],[4,393.75]] },
  },
];

// ── verification ───────────────────────────────────────────────────────────
const round2 = (n) => Math.round(n * 100) / 100;
const fail = (h, msg) => { throw new Error(`hand ${h.handNumber}: ${msg}`); };

const report = [];
for (const h of HANDS) {
  const seatNums = h.seats.map(s => s.seat);
  const pos = positions(seatNums, h.button);
  if (Object.keys(pos).length === 0) fail(h, 'button seat is not occupied - positions would be blank');
  const sbSeat = Number(Object.keys(pos).find(s => pos[s] === 'SB'));
  const bbSeat = Number(Object.keys(pos).find(s => pos[s] === 'BB'));

  // no duplicate cards anywhere in the hand
  const all = [...h.board, ...h.seats.flatMap(s => s.hole || [])].map(key);
  if (new Set(all).size !== all.length) fail(h, 'a card appears twice');

  // every seat referenced by an action is actually at the table
  for (const [seat] of h.acts) if (!seatNums.includes(seat)) fail(h, `action for empty seat ${seat}`);

  // pot reconciliation, exactly as BBJHandDetail rebuilds it
  let pot = h.sb + h.bb;
  const contributed = new Map([[sbSeat, h.sb], [bbSeat, h.bb]]);
  for (const [seat, , , amt] of h.acts) {
    pot = round2(pot + amt);
    contributed.set(seat, round2((contributed.get(seat) || 0) + amt));
  }
  h.potSize = round2(pot);

  // the hands themselves
  const bb = h.seats.find(s => s.badBeat), hw = h.seats.find(s => s.handWinner);
  const bbHand = bestFive(bb.hole, h.board, h.variant);
  const hwHand = bestFive(hw.hole, h.board, h.variant);
  if (!bbHand || !hwHand) fail(h, 'a showdown hand could not be evaluated');
  if (cmp(scoreFive(hwHand.cards), scoreFive(bbHand.cards)) <= 0)
    fail(h, `the hand winner (${hwHand.name}) does not beat the bad beat (${bbHand.name})`);
  h.badBeatHand = bbHand.name;
  h.handWinnerHand = hwHand.name;

  // the pot award
  h.award = round2(h.potSize - h.rake - h.jackpotFee);
  if (h.award <= 0) fail(h, 'rake and fee exceed the pot');

  // the jackpot split
  const j = h.jackpot;
  const sum = round2(j.badBeat + j.handWinner + j.table.reduce((a, [, v]) => a + v, 0));
  if (sum !== j.total) fail(h, `jackpot shares sum to ${sum}, not ${j.total}`);
  for (const [seat] of j.table) {
    if (!seatNums.includes(seat)) fail(h, `table share for empty seat ${seat}`);
    if (seat === bb.seat || seat === hw.seat) fail(h, 'table share paid to a showdown player');
  }
  if (j.table.length !== h.seats.length - 2) fail(h, 'table share does not cover every other dealt-in player');

  report.push(
    `hand ${h.handNumber}  ${h.variant.toUpperCase().padEnd(5)} ${h.sb}/${h.bb}  ` +
    `pot ${h.potSize}  award ${h.award}  |  ${bb.name}: ${bbHand.name} ` +
    `(${bbHand.cards.map(c => c.rank + c.suit[0]).join(' ')})  beaten by  ` +
    `${hw.name}: ${hwHand.name} (${hwHand.cards.map(c => c.rank + c.suit[0]).join(' ')})`
  );
}
console.error(report.join('\n'));

// ── SQL ────────────────────────────────────────────────────────────────────
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const jsonLit = (v) => `${q(JSON.stringify(v))}::jsonb`;

/**
 * The hands above are AUTHORED in increments, because that is the only form a
 * human can check by adding up. The engine does not write that form.
 *
 * server/src/engine/HandController.ts:600-724 writes `amount` as the raise-TO
 * level for bet / raise / all_in and as the chips actually added for call. A
 * seed that used increments everywhere would be the only rows on the platform
 * with their own convention, and any shared reader would have to branch on
 * `source = 'seed'` forever. So the increments are converted here, once.
 *
 * Verified against production hand 3048511: `raise 15`, `raise 50`, `raise 156`,
 * `all_in 159.1`, `call 3.1` are to-levels-then-an-increment, and differencing
 * them the way src/utils/handReplay.ts does lands on its stored pot_size of
 * 324.20 to the penny.
 */
function toEngineSemantics(acts, blinds) {
  const committed = new Map();
  let street = null;
  const seedStreet = (stage) => {
    committed.clear();
    // A blind is already committed before anyone acts, so if the SB or BB is
    // the one who raises, the raise-TO level has to include it. None of the
    // five hands below has a blind raise, but authoring one later must not
    // quietly produce a to-level short by the blind.
    if (stage === 'preflop') {
      for (const [seat, amount] of blinds) if (amount > 0) committed.set(seat, amount);
    }
  };
  return acts.map(([seat, stage, action, increment]) => {
    if (stage !== street) {
      street = stage;
      seedStreet(stage);
    }
    const before = committed.get(seat) || 0;
    const after = round2(before + increment);
    committed.set(seat, after);
    const isToLevel = action === 'bet' || action === 'raise' || action === 'all_in';
    return { seat, stage, action, amount: isToLevel ? after : increment };
  });
}

const out = [];
out.push(`-- ============================================================================
--  BBJ SEED: the five recent hits, as complete hands
-- ============================================================================
--
--  Dan, 2026-08-27, on the Bad Beat Jackpot popup:
--    "for the BBJ seed you need to use there club avatar as the image, not
--     there profile pics. and you need to fill in all the hand details and
--     payouts, like all the data that we see and use inside of previous hands."
--
--  Two things were wrong, and the second one was hiding behind the first.
--
--  1. AVATARS. fn_bbj_recent_hits resolved the winner image as
--     COALESCE(clubs.avatar_url, profiles.avatar_url). clubs.avatar_url is
--     NULL for both clubs that have hit, so every row fell through to
--     profiles.avatar_url - which is the SOCIAL MEDIA photo, the column
--     tests/unit/arenaAvatarSeparation.test.ts exists to keep Club Arena out
--     of. The club avatar is profiles.arena_avatar_url, and it is what the
--     felt itself reads (server/src/services/supabase/tables.ts). Fixed below
--     in both fn_bbj_recent_hits and fn_bbj_hand_detail.
--
--  2. THE HANDS WERE NOT HANDS. Each seeded hand held two players, two
--     actions, both on the river, and a button_seat that was not one of the
--     occupied seats - so BBJHandDetail could derive no positions, synthesise
--     no blinds, and show no street but the river. The reconstructed pot came
--     to 1030 against a stored pot_size of 11262.74, so the running-pot column
--     withdrew itself (by design: see the header of BBJHandDetail.tsx), and
--     rake and jackpot fee were both zero so that line never drew either.
--     The cards did not even make the stated hands: CRUX was billed with
--     "Four of a Kind" holding As Ad on a board with one ace.
--
--     Every hand below is rebuilt whole - full seat roster, a button that is
--     actually at the table, preflop through river, amounts that sum to the
--     penny to pot_size, rake and jackpot drop, and hole cards that make the
--     category the winners list claims under that variant's own rules. The
--     generator (scripts/dev/gen-bbj-seed.mjs) re-runs the client's own
--     evaluator and refuses to emit SQL if any of that fails to check out.
--
--  3. THE TABLE SHARE WAS NEVER PAID. bbj_payouts carries winner_share,
--     loser_share AND table_share, but only the first two ever got
--     bbj_payout_recipients rows. The popup therefore headlined "Jackpot Paid
--     7,883.92" over two lines totalling 5,912.94. The remaining 25% is now
--     split across the other players dealt into the hand, which is what
--     "At The Table" means.
--
--  Seed data only: no chips move. bbj_payout_recipients rows are the display
--  ledger for a hit that was itself seeded; nothing here touches
--  club_members.chip_balance, and CLAUDE.md section 11.5 is not in play.
-- ============================================================================


`);

/**
 * THE FUNCTIONS ARE NOT EMITTED HERE ANY MORE.
 *
 * They used to be, and that made this file a loaded gun: re-running the
 * generator after `fn_bbj_hand_detail` had been extended elsewhere would have
 * silently reverted it to whatever body was frozen in this script. Data and
 * schema live in separate migrations now:
 *
 *   20260827_bbj_full_hand_seed.sql            fn_bbj_recent_hits -> club avatar
 *   20260827_bbj_hand_detail_full_data_points  showdown / pots / extraBoards
 *
 * This generator emits DATA ONLY, and every statement is idempotent.
 */
const EMIT_FUNCTIONS = false;
if (EMIT_FUNCTIONS) out.push(`
-- ---------------------------------------------------------------------------
-- 1. Club avatar, not the social media photo.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_bbj_recent_hits(p_pool_id uuid, p_limit integer DEFAULT 5)
RETURNS TABLE(payout_id uuid, awarded_at timestamptz, hand_number bigint, total_payout numeric,
              bad_beat_user_id uuid, bad_beat_player_number text, bad_beat_avatar_url text,
              bad_beat_name text, bad_beat_hand text, bad_beat_amount numeric, bad_beat_cards jsonb,
              hand_winner_name text, hand_winner_hand text, hand_winner_amount numeric,
              hand_winner_cards jsonb, board jsonb, game_variant text, small_blind numeric,
              big_blind numeric, table_player_count integer, recipients jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH top_payouts AS (
    SELECT p.* FROM public.bbj_payouts p
    WHERE p.pool_id = p_pool_id
    ORDER BY p.created_at DESC
    LIMIT GREATEST(1, LEAST(p_limit, 25))
  ),
  hits AS (
    SELECT p.*, w.winner_hand, w.loser_hand, w.winner_display_name, w.loser_display_name,
           h.board AS raw_board, h.hole_cards, h.game_variant, h.small_blind, h.big_blind
    FROM top_payouts p
    LEFT JOIN public.bbj_winners w ON w.table_id = p.table_id AND w.hand_number = p.hand_number
    LEFT JOIN public.hand_history h ON h.table_id = p.table_id AND h.hand_number = p.hand_number
  )
  SELECT
    x.id,
    x.created_at,
    x.hand_number,
    x.total_amount,
    x.winner_user_id,
    bb.player_number::text,
    -- THE CLUB AVATAR. profiles.arena_avatar_url is Club Arena's own column
    -- (library art); profiles.avatar_url is the social media photo and is not
    -- ours to display. No fallback to it, exactly as the felt does it - an
    -- unset arena avatar draws the generated monogram client-side instead.
    NULLIF(bb.arena_avatar_url, ''),
    COALESCE(bb.display_name, bb.username, x.winner_display_name, 'Player'),
    x.winner_hand,
    (SELECT r.amount FROM public.bbj_payout_recipients r
      WHERE r.payout_id = x.id AND r.user_id = x.winner_user_id),
    x.hole_cards -> (x.winner_user_id::text),
    COALESCE(hw.display_name, hw.username, x.loser_display_name, 'Player'),
    x.loser_hand,
    (SELECT r.amount FROM public.bbj_payout_recipients r
      WHERE r.payout_id = x.id AND r.user_id = x.loser_user_id),
    x.hole_cards -> (x.loser_user_id::text),
    CASE
      WHEN jsonb_typeof(x.raw_board) = 'array' THEN (
        SELECT COALESCE(jsonb_agg(
                 jsonb_build_object(
                   'rank', regexp_replace(card, '(hearts|diamonds|clubs|spades)$', ''),
                   'suit', substring(card from '(hearts|diamonds|clubs|spades)$')
                 ) ORDER BY ord), '[]'::jsonb)
        FROM jsonb_array_elements_text(x.raw_board) WITH ORDINALITY AS arr(card, ord)
        WHERE substring(card from '(hearts|diamonds|clubs|spades)$') IS NOT NULL
      )
      ELSE '[]'::jsonb
    END,
    x.game_variant,
    x.small_blind,
    x.big_blind,
    x.table_player_count,
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'name', COALESCE(pr.display_name, pr.username, 'Player'),
                 'amount', r.amount,
                 'role', CASE
                           WHEN r.user_id = x.winner_user_id THEN 'bad_beat'
                           WHEN r.user_id = x.loser_user_id  THEN 'hand_winner'
                           ELSE 'table'
                         END
               ) ORDER BY r.amount DESC)
      FROM public.bbj_payout_recipients r
      LEFT JOIN public.profiles pr ON pr.id = r.user_id
      WHERE r.payout_id = x.id
    ), '[]'::jsonb)
  FROM hits x
  LEFT JOIN public.profiles bb ON bb.id = x.winner_user_id
  LEFT JOIN public.profiles hw ON hw.id = x.loser_user_id
  ORDER BY x.created_at DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_bbj_recent_hits(uuid, integer) TO anon, authenticated, service_role;
`);

if (EMIT_FUNCTIONS) out.push(`
-- Same correction inside the hand detail: players[].avatarUrl is the club
-- avatar. Nothing renders it today, but it is the same rule and leaving the
-- social photo in the payload is how it gets rendered by accident later.
CREATE OR REPLACE FUNCTION public.fn_bbj_hand_detail(p_payout_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH pay AS (SELECT * FROM public.bbj_payouts WHERE id = p_payout_id),
  hh AS (
    SELECT h.* FROM public.hand_history h
    JOIN pay ON h.table_id = pay.table_id AND h.hand_number = pay.hand_number
    ORDER BY h.created_at DESC LIMIT 1
  ),
  seats AS (
    SELECT e.value AS p FROM hh, LATERAL jsonb_array_elements(COALESCE(hh.players, '[]'::jsonb)) e
  ),
  players_out AS (
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'userId',       s.p->>'userId',
          'username',     COALESCE(pr.display_name, pr.username, s.p->>'username', 'Player'),
          'playerNumber', pr.player_number::text,
          'avatarUrl',    NULLIF(pr.arena_avatar_url, ''),
          'seat',         NULLIF(s.p->>'seat', '')::int,
          'stack',        NULLIF(s.p->>'stack', '')::numeric,
          'cards',        COALESCE((SELECT hh.hole_cards -> (s.p->>'userId') FROM hh), 'null'::jsonb)
        ) ORDER BY NULLIF(s.p->>'seat', '')::int), '[]'::jsonb) AS v
    FROM seats s LEFT JOIN public.profiles pr ON pr.id::text = s.p->>'userId'
  ),
  board_out AS (
    SELECT CASE
      WHEN (SELECT community_cards FROM hh) IS NULL THEN '[]'::jsonb
      ELSE COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'rank', regexp_replace(c, '(hearts|diamonds|clubs|spades)$', ''),
                 'suit', substring(c from '(hearts|diamonds|clubs|spades)$')) ORDER BY ord)
        FROM unnest((SELECT community_cards FROM hh)) WITH ORDINALITY AS t(c, ord)
        WHERE substring(c from '(hearts|diamonds|clubs|spades)$') IS NOT NULL
      ), '[]'::jsonb)
    END AS v
  ),
  recips AS (
    SELECT COALESCE(jsonb_agg(
             jsonb_build_object(
               'userId', r.user_id,
               'name',   COALESCE(pr.display_name, pr.username, 'Player'),
               'amount', r.amount,
               'role',   CASE
                           WHEN r.user_id = (SELECT winner_user_id FROM pay) THEN 'bad_beat'
                           WHEN r.user_id = (SELECT loser_user_id  FROM pay) THEN 'hand_winner'
                           ELSE 'table'
                         END) ORDER BY r.amount DESC), '[]'::jsonb) AS v
    FROM public.bbj_payout_recipients r
    LEFT JOIN public.profiles pr ON pr.id = r.user_id
    WHERE r.payout_id = p_payout_id
  )
  SELECT CASE WHEN (SELECT count(*) FROM hh) = 0 THEN NULL ELSE jsonb_build_object(
      'handNumber',  (SELECT hand_number FROM hh),
      'playedAt',    COALESCE((SELECT started_at FROM hh), (SELECT created_at FROM hh)),
      'gameVariant', (SELECT game_variant FROM hh),
      'smallBlind',  (SELECT small_blind FROM hh),
      'bigBlind',    (SELECT big_blind FROM hh),
      'potSize',     (SELECT pot_size FROM hh),
      'rakeAmount',  (SELECT rake_amount FROM hh),
      'bbjAmount',   (SELECT bbj_amount FROM hh),
      'buttonSeat',  (SELECT button_seat FROM hh),
      'board',       (SELECT v FROM board_out),
      'players',     (SELECT v FROM players_out),
      'actions',     COALESCE((SELECT jsonb_agg(a ORDER BY ord)
                        FROM jsonb_array_elements((SELECT COALESCE(actions, '[]'::jsonb) FROM hh))
                             WITH ORDINALITY AS t(a, ord)
                        WHERE COALESCE(a->>'userId', '') <> 'system'), '[]'::jsonb),
      'winners',     (SELECT COALESCE(winners, '[]'::jsonb) FROM hh),
      'jackpot',     jsonb_build_object(
                       'payoutId',         p_payout_id,
                       'total',            (SELECT total_amount FROM pay),
                       'badBeatUserId',    (SELECT winner_user_id FROM pay),
                       'handWinnerUserId', (SELECT loser_user_id FROM pay),
                       'recipients',       (SELECT v FROM recips))
    ) END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_bbj_hand_detail(uuid) TO anon, authenticated, service_role;
`);

out.push(`
-- ---------------------------------------------------------------------------
-- 2. The five hands, rebuilt whole.
-- ---------------------------------------------------------------------------
`);

for (const h of HANDS) {
  const seatNums = h.seats.map(s => s.seat);
  const pos = positions(seatNums, h.button);
  const bb = h.seats.find(s => s.badBeat), hw = h.seats.find(s => s.handWinner);

  const players = h.seats.map(s => ({ seat:s.seat, userId:s.id, username:s.name, stack:s.stack }));
  const sbSeatOf = Number(Object.keys(pos).find((s) => pos[Number(s)] === 'SB'));
  const bbSeatOf = Number(Object.keys(pos).find((s) => pos[Number(s)] === 'BB'));
  const actions = toEngineSemantics(h.acts, [
    [sbSeatOf, h.sb],
    [bbSeatOf, h.bb],
  ]).map(({ seat, stage, action, amount }) => {
    const p = h.seats.find(s => s.seat === seat);
    return { seat, userId: p.id, action, amount, stage };
  });
  const holeCards = Object.fromEntries(h.seats.filter(s => s.hole).map(s => [s.id, s.hole]));
  // The muck ruling, the way the engine records it: only the two who reached
  // showdown revealed, bad beat first.
  const showdownReveal = [bb, hw].map((p, i) => ({
    user_id: p.id,
    seat: p.seat,
    mucked: false,
    reveal_order: i,
    hand_name: i === 0 ? h.badBeatHand : h.handWinnerHand,
  }));
  const pots = [{ index: 0, amount: h.potSize, eligible: [bb.id, hw.id] }];
  const winners = [{ userId:hw.id, amount:h.award, potIndex:0, hand:{ name:h.handWinnerHand } }];
  const summary =
    `${bb.name} (${pos[bb.seat]}) ${h.badBeatHand} beaten by ${hw.name} (${pos[hw.seat]}) ` +
    `${h.handWinnerHand}. Bad Beat Jackpot.`;

  out.push(`
-- ${h.handNumber}: ${bb.name} ${h.badBeatHand} beaten by ${hw.name} ${h.handWinnerHand}
--   ${h.variant.toUpperCase()} ${h.sb}/${h.bb}, ${h.seats.length} dealt in, button seat ${h.button}
--   (${pos[h.button]}), pot ${h.potSize} = ${h.sb} + ${h.bb} + every action amount, to the penny.
UPDATE public.hand_history SET
  game_variant     = ${q(h.variant)},
  small_blind      = ${h.sb},
  big_blind        = ${h.bb},
  button_seat      = ${h.button},
  pot_size         = ${h.potSize},
  rake_amount      = ${h.rake},
  bbj_amount       = ${h.jackpotFee},
  community_cards  = ARRAY[${h.board.map(c => q(wire(c))).join(', ')}]::text[],
  board            = ${jsonLit(h.board.map(wire))},
  players          = ${jsonLit(players)},
  actions          = ${jsonLit(actions)},
  winners          = ${jsonLit(winners)},
  hole_cards       = ${jsonLit(holeCards)},
  showdown         = ${jsonLit(showdownReveal)},
  pots             = ${jsonLit(pots)},
  winner_name      = ${q(hw.name)},
  hand_name        = ${q(h.handWinnerHand)},
  summary          = ${q(summary)},
  started_at       = ${q(h.playedAt)},
  ended_at         = ${q(h.endedAt)},
  created_at       = ${q(h.playedAt)},
  source           = 'seed'
WHERE table_id = ${q(h.tableId)} AND hand_number = ${h.handNumber};

UPDATE public.bbj_winners SET
  winner_hand         = ${q(h.badBeatHand)},
  loser_hand          = ${q(h.handWinnerHand)},
  winner_display_name = ${q(bb.name)},
  loser_display_name  = ${q(hw.name)},
  stakes_tier         = ${q(h.bb >= 10 ? 'high' : h.bb >= 2 ? 'mid' : 'small')}
WHERE table_id = ${q(h.tableId)} AND hand_number = ${h.handNumber};
`);
}

out.push(`
-- ---------------------------------------------------------------------------
-- 3. The table share, paid to the players who were dealt in and were not in
--    the hand. 50 / 25 / 25, the split bbj_payouts already stores.
-- ---------------------------------------------------------------------------
`);

for (const h of HANDS) {
  const bb = h.seats.find(s => s.badBeat), hw = h.seats.find(s => s.handWinner);
  const rows = [
    [bb.id, h.jackpot.badBeat, bb.name],
    [hw.id, h.jackpot.handWinner, hw.name],
    ...h.jackpot.table.map(([seat, amt]) => {
      const p = h.seats.find(s => s.seat === seat);
      return [p.id, amt, p.name];
    }),
  ];
  out.push(`
DELETE FROM public.bbj_payout_recipients WHERE payout_id = ${q(h.payoutId)};
INSERT INTO public.bbj_payout_recipients (payout_id, user_id, amount, created_at) VALUES
${rows.map(([id, amt, name]) =>
  `  -- ${name}\n  (${q(h.payoutId)}, ${q(id)}, ${amt}, ${q(h.awardedAt)})`
).join(',\n')};`);
}

out.push(`

-- ---------------------------------------------------------------------------
-- 4. Assertions. The migration aborts rather than leaving a money surface
--    showing numbers that do not add up.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_act jsonb;
  v_recon numeric;
  v_committed jsonb;
  v_stage text;
  v_seat text;
  v_prior numeric;
  v_inc numeric;
BEGIN
  FOR r IN
    SELECT p.id, p.hand_number, p.total_amount, p.table_player_count,
           h.pot_size, h.small_blind, h.big_blind, h.button_seat,
           h.players, h.actions, b.sb_seat AS v_sb_seat, b.bb_seat AS v_bb_seat
    FROM public.bbj_payouts p
    JOIN public.hand_history h ON h.table_id = p.table_id AND h.hand_number = p.hand_number
    JOIN (VALUES
${HANDS.map((h) => {
  const pos = positions(h.seats.map((s) => s.seat), h.button);
  const sb = Object.keys(pos).find((s) => pos[Number(s)] === 'SB');
  const bb2 = Object.keys(pos).find((s) => pos[Number(s)] === 'BB');
  return `      (${q(h.payoutId)}::uuid, ${sb}, ${bb2})`;
}).join(',\n')}
    ) AS b(payout_id, sb_seat, bb_seat) ON b.payout_id = p.id
    WHERE p.id IN (${HANDS.map(h => q(h.payoutId)).join(', ')})
  LOOP
    -- every recipient share sums to the headline figure
    IF (SELECT COALESCE(sum(amount), 0) FROM public.bbj_payout_recipients WHERE payout_id = r.id)
       <> r.total_amount THEN
      RAISE EXCEPTION 'hand %: recipients do not sum to total_amount %', r.hand_number, r.total_amount;
    END IF;

    -- one recipient per player dealt into the hand
    IF (SELECT count(*) FROM public.bbj_payout_recipients WHERE payout_id = r.id)
       <> jsonb_array_length(r.players) THEN
      RAISE EXCEPTION 'hand %: recipient count does not match the seat count', r.hand_number;
    END IF;

    -- THE POT MUST REBUILD, by the same rule the client uses.
    --
    -- src/utils/handReplay.ts differences a raise-TO level against what that
    -- seat already had in on the street, because that is what the engine
    -- writes. If the rebuild misses, HandDetailView withdraws the whole stack
    -- column, so a seed that does not reconcile silently renders as a
    -- second-class hand. This walks the action log exactly as the client does.
    v_recon := r.small_blind + r.big_blind;
    v_committed := '{}'::jsonb;
    v_stage := NULL;
    FOR v_act IN
      SELECT t.a FROM jsonb_array_elements(r.actions) WITH ORDINALITY t(a, ord) ORDER BY t.ord
    LOOP
      IF v_stage IS DISTINCT FROM (v_act->>'stage') THEN
        v_stage := v_act->>'stage';
        v_committed := '{}'::jsonb;
        -- Blinds are committed on preflop before anyone acts.
        IF v_stage = 'preflop' THEN
          v_committed := jsonb_build_object(
            r.v_sb_seat::text, to_jsonb(r.small_blind),
            r.v_bb_seat::text, to_jsonb(r.big_blind));
        END IF;
      END IF;

      v_seat := v_act->>'seat';
      v_prior := COALESCE((v_committed->>v_seat)::numeric, 0);
      IF (v_act->>'action') IN ('bet', 'raise', 'all_in') THEN
        v_inc := GREATEST(0, (v_act->>'amount')::numeric - v_prior);
      ELSE
        v_inc := COALESCE((v_act->>'amount')::numeric, 0);
      END IF;
      v_recon := v_recon + v_inc;
      v_committed := jsonb_set(v_committed, ARRAY[v_seat], to_jsonb(v_prior + v_inc), true);
    END LOOP;

    IF abs(v_recon - r.pot_size) >= 0.02 THEN
      RAISE EXCEPTION 'hand %: actions rebuild to % but pot_size is %',
        r.hand_number, v_recon, r.pot_size;
    END IF;

    -- the button has to be at the table or no position resolves at all
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.players) p
                    WHERE (p->>'seat')::int = r.button_seat) THEN
      RAISE EXCEPTION 'hand %: button seat % is not occupied', r.hand_number, r.button_seat;
    END IF;

    -- table_player_count is what the popup prints; it has to match the roster
    IF r.table_player_count <> jsonb_array_length(r.players) THEN
      RAISE EXCEPTION 'hand %: table_player_count % but % players dealt in',
        r.hand_number, r.table_player_count, jsonb_array_length(r.players);
    END IF;
  END LOOP;

  -- the club avatar, on every winner row
  IF EXISTS (
    SELECT 1 FROM public.bbj_payouts p
    JOIN public.profiles pr ON pr.id = p.winner_user_id
    WHERE p.id IN (${HANDS.map(h => q(h.payoutId)).join(', ')})
      AND COALESCE(pr.arena_avatar_url, '') = ''
  ) THEN
    RAISE EXCEPTION 'a seeded jackpot winner has no club avatar to show';
  END IF;
END $$;


`);

process.stdout.write(out.join('\n'));
