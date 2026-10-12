import assert from 'node:assert/strict';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const boundaries = new Set(['pot_win', 'pot_distributed', 'hand_complete']);
const complete = new Set(['COMPLETED', 'FINISHED', 'ENDED']);

// Actual authenticated reads only. Caller owns a finite run/deadline; this
// adapter has no polling loop, state repair, seating, or financial write route.
export async function readTournamentWitness({ tournamentId, users, session, anonKey, signal }) {
  assert.match(tournamentId, uuid); assert.ok(users.length >= 2 && users.length <= 1000);
  const ids = users.map(u => u.id); ids.forEach(id => assert.match(id, uuid));
  assert.equal(new Set(ids).size, ids.length);
  async function get(table, params, cap) {
    const url = new URL('http://gateway:8000/rest/v1/' + table);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('limit', String(cap + 1));
    const res = await fetch(url, { redirect: 'error', headers: { authorization: `Bearer ${session.access_token}`, apikey: anonKey, Prefer: 'count=exact' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
    assert.ok(res.ok, `tournament witness ${table} HTTP ${res.status}`);
    const rows = await res.json(); assert.ok(Array.isArray(rows));
    const range = res.headers.get('content-range'); assert.ok(range && /\/\d+$/.test(range), 'exact count absent');
    assert.equal(Number(range.split('/')[1]), rows.length, 'truncated tournament witness');
    assert.ok(rows.length <= cap, 'unbounded tournament witness'); return rows;
  }
  const tournaments = await get('tournaments', { select: 'id,status,current_players,ended_at', id: `eq.${tournamentId}` }, 1);
  assert.equal(tournaments.length, 1);
  const players = await get('tournament_players', { select: 'user_id,table_id,status,position,eliminated_at,chip_count', tournament_id: `eq.${tournamentId}` }, users.length);
  const tables = await get('tables', { select: 'id,tournament_id,status', tournament_id: `eq.${tournamentId}` }, users.length);
  const seats = tables.length ? await get('table_seats', { select: 'user_id,table_id,seat_number,occupancy_id,stack,left_at', table_id: `in.(${tables.map(t => t.id).join(',')})`, left_at: 'is.null' }, users.length) : [];
  const value = { observedAt: new Date().toISOString(), tournament: tournaments[0], players, tables, seats };
  validateTournamentWitness(value, ids);
  return value;
}

export function validateTournamentWitness(w, ids) {
  assert.ok(w && w.tournament && Array.isArray(w.players) && Array.isArray(w.tables) && Array.isArray(w.seats));
  assert.equal(w.players.length, ids.length, 'every registered load identity required');
  assert.deepEqual([...w.players.map(p => p.user_id)].sort(), [...ids].sort(), 'unrelated/duplicate player identity');
  const tables = new Map(w.tables.map(t => [t.id, t]));
  assert.equal(tables.size, w.tables.length);
  for (const table of tables.values()) { assert.match(table.id, uuid); assert.equal(table.tournament_id, w.tournament.id); }
  assert.equal(new Set(w.seats.map(s => s.user_id)).size, w.seats.length, 'duplicate active occupant');
  assert.equal(new Set(w.seats.map(s => s.occupancy_id)).size, w.seats.length, 'duplicate occupancy');
  for (const seat of w.seats) {
    assert.ok(ids.includes(seat.user_id)); assert.ok(tables.has(seat.table_id)); assert.match(seat.occupancy_id, uuid);
    assert.equal(seat.left_at, null); assert.ok(Number.isInteger(seat.seat_number) && seat.seat_number>=1 && seat.seat_number<=9);
    assert.ok(Number.isFinite(Number(seat.stack)) && Number(seat.stack)>=0);
    const player = w.players.find(p=>p.user_id===seat.user_id);
    assert.equal(player.table_id, seat.table_id, 'registration/seat table disagreement');
  }
  const status = String(w.tournament.status).toUpperCase();
  assert.ok(['REGISTERING','ANNOUNCED','RUNNING',...complete].includes(status), 'refused/unknown tournament outcome');
  if (complete.has(status)) assert.ok(Number.isFinite(Date.parse(w.tournament.ended_at)), 'missing actual tournament ending');
  for (const player of w.players) if (player.status==='eliminated') {
    assert.equal(Number(player.chip_count),0); assert.ok(Number(player.position)>0);
    assert.ok(Number.isFinite(Date.parse(player.eliminated_at)), 'unproven elimination');
  }
  return w;
}

// Relocation permission is based on durable same-tournament player/seat rows.
// An engine_restarting frame or empty snapshot alone never permits recovery.
export function validateBoardTransition({ before, after, tableId, boundary, lastGameplay, teardown, settledHand }) {
  assert.equal(before.tournament.id, after.tournament.id);
  assert.ok(boundary && lastGameplay && settledHand, 'missing connected ending-hand witness');
  assert.ok(boundaries.has(boundary.type), 'no witnessed hand boundary');
  assert.equal(boundary.tableId, tableId); assert.equal(lastGameplay.tableId, tableId);
  assert.ok(Number.isSafeInteger(boundary.handNumber) && boundary.handNumber>0);
  assert.ok(Number.isSafeInteger(boundary.eventSequence) && boundary.eventSequence>=0);
  assert.equal(lastGameplay.handNumber,boundary.handNumber);
  assert.equal(lastGameplay.eventSequence,boundary.eventSequence,'a later gameplay event invalidates an old boundary');
  assert.equal(lastGameplay.type,boundary.type);
  assert.equal(settledHand.tableId,tableId); assert.equal(settledHand.handNumber,boundary.handNumber);
  assert.equal(settledHand.conservationChecked,true);
  assert.equal(settledHand.postCommitOk,true,'ending hand postcommit result not successful');
  assert.ok(Number.isFinite(Date.parse(settledHand.postCommitCompletedAt)),'ending hand not durably postcommitted');
  if (teardown) {
    assert.equal(teardown.tableId,tableId); assert.equal(teardown.count,1);
    assert.ok(teardown.eventSequence>boundary.eventSequence,'teardown preceded ending hand');
    assert.ok(Number.isFinite(Date.parse(teardown.receivedAt)) && Date.parse(teardown.receivedAt)>=Date.parse(boundary.receivedAt));
  }
  const old = after.tables.find(t=>t.id===tableId);
  assert.ok(old && old.status==='closed', 'old board not durably closed');
  assert.equal(after.seats.filter(s=>s.table_id===tableId).length,0, 'old board still occupied');
  const original = before.seats.filter(s=>s.table_id===tableId);
  assert.ok(original.length>=2);
  const terminal = complete.has(String(after.tournament.status).toUpperCase());
  if (terminal) {
    assert.ok(Number.isFinite(Date.parse(after.tournament.ended_at)));
    return { kind:'completed', product_certificate:false, requiresPayoutWitness:true };
  }
  assert.equal(String(after.tournament.status).toUpperCase(),'RUNNING');
  const moved=[];
  for (const seat of original) {
    const p=after.players.find(p=>p.user_id===seat.user_id); assert.ok(p);
    if (p.status==='eliminated') {
      assert.equal(Number(p.chip_count),0); assert.ok(Number(p.position)>0 && Number.isFinite(Date.parse(p.eliminated_at))); continue;
    }
    assert.equal(p.status,'playing'); assert.notEqual(p.table_id,tableId);
    const destination=after.tables.find(t=>t.id===p.table_id);
    assert.ok(destination && destination.tournament_id===before.tournament.id && ['running','waiting'].includes(destination.status));
    const assigned=after.seats.filter(s=>s.user_id===p.user_id && s.table_id===p.table_id && Number(s.stack)>0);
    assert.equal(assigned.length,1,'unproven player relocation');
    moved.push({userId:p.user_id,tableId:p.table_id,occupancyId:assigned[0].occupancy_id});
  }
  assert.ok(moved.length>0,'no witnessed relocation');
  return {kind:'relocated',moved,product_certificate:false};
}

export async function registerTournamentActor({tournamentId,user,requestId,anonKey,checkpoint,signal}) {
  assert.match(tournamentId,uuid);assert.match(user.id,uuid);assert.match(requestId,uuid);
  assert.equal(typeof checkpoint,'function');
  const claims=JSON.parse(Buffer.from(user.session.access_token.split('.')[1],'base64url'));
  assert.equal(claims.sub,user.id);assert.equal(claims.role,'authenticated');
  assert.ok(claims.exp>Date.now()/1000+300);
  const operation={actorId:user.id,tournamentId,requestId,phase:'unknown',started:new Date().toISOString()};
  await checkpoint(operation); // Must durably retain identity before possible debit.
  const response=await fetch('http://gateway:8000/rest/v1/rpc/fn_register_for_tournament_request',{
    method:'POST',redirect:'error',headers:{authorization:`Bearer ${user.session.access_token}`,apikey:anonKey,'content-type':'application/json'},
    body:JSON.stringify({p_tournament_id:tournamentId,p_request_id:requestId}),
    signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)
  });
  const raw=await response.text();const returnedAt=new Date().toISOString();assert.ok(raw.length<=65536);
  const result=raw?JSON.parse(raw):null;
  await checkpoint({...operation,phase:'returned',returnedAt,httpStatus:response.status,result});
  assert.ok(response.ok && result?.ok===true,'actual tournament admission refused');
  assert.match(result.registration_id,uuid);
  if(result.request_id!==undefined)assert.equal(result.request_id,requestId);
  if(result.user_id!==undefined)assert.equal(result.user_id,user.id);
  if(result.tournament_id!==undefined)assert.equal(result.tournament_id,tournamentId);
  return {operation,result,requiresDurableRegistrationRead:true,product_certificate:false};
}
