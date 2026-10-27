#!/usr/bin/env python3
"""One manual read-only host diagnostic; raw log bytes never leave this process."""
import datetime
import base64
import hashlib
import json
import re
import selectors
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

CONTAINER = 'club-arena-engine'
MAX_BYTES = 4 * 1024 * 1024
REFERENCE_CASE_BYTES = 8192


def reference_cases(raw, expected):
    """Exact original metadata only; never an operator command or journal path."""
    if len(raw) > REFERENCE_CASE_BYTES:
        raise ValueError('reference_cases_refused')
    def unique_object(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError('reference_cases_refused')
            value[key] = item
        return value
    value = json.loads(raw.decode('utf-8', errors='strict'), object_pairs_hook=unique_object)
    uuid = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    if (not isinstance(value, dict) or set(value) != {'version', 'sourceRelease', 'cases'}
            or type(value['version']) is not int or value['version'] not in (1, 2)
            or value['sourceRelease'] != expected
            or not re.fullmatch(r'[0-9a-f]{40}', expected)
            or not isinstance(value['cases'], list) or not 1 <= len(value['cases']) <= 6):
        raise ValueError('reference_cases_refused')
    positive = value['version'] == 2
    seen = set()
    for case in value['cases']:
        if (not isinstance(case, dict) or set(case) != {
                'handKey', 'tableId', 'decisionRecordSha256' if positive else 'errorAt', 'handId', 'handNumber', 'leaseGeneration'}
                or not all(isinstance(case[k], str) and re.fullmatch(uuid, case[k])
                           for k in ('tableId', 'handId', 'leaseGeneration'))
                or type(case['handNumber']) is not int or not 1 <= case['handNumber'] <= 9007199254740991
                or (positive and case['decisionRecordSha256'] is not None
                    and (not isinstance(case['decisionRecordSha256'], str)
                        or not re.fullmatch(r'[0-9a-f]{64}', case['decisionRecordSha256'])))
                or (not positive and (not isinstance(case['errorAt'], str)
                    or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z', case['errorAt'])))
                or not isinstance(case['handKey'], str)
                or not re.fullmatch(r'[0-9a-f]{64}', case['handKey'])):
            raise ValueError('reference_cases_refused')
        if not positive:
            datetime.datetime.fromisoformat(case['errorAt'].replace('Z', '+00:00'))
        coordinate = case['tableId'] + ':' + str(case['handNumber']) + ':' + case['leaseGeneration']
        if hashlib.sha256(coordinate.encode('utf-8')).hexdigest() != case['handKey'] or case['handKey'] in seen:
            raise ValueError('reference_cases_refused')
        seen.add(case['handKey'])
    return value


# Runs in the EXISTING container, imports its actual compiled validator and
# canonical read-only export API. No private record crosses the process output.
REFERENCE_DIAGNOSTIC_JS = r'''
import { createHash } from 'node:crypto';
const hash = x => createHash('sha256').update(x).digest('hex');
const routes = new Set(['legacy_preflop','chart_open_jam','chart_bb_defend','variant_price','intent_engine']);
const actions = new Set(['fold','check','call','bet','raise','all_in']);
export function inspectReferenceRecords(input, batch, api) {
  const unknown = (c, reason) => ({handKey:c.handKey,status:'unknown',reason});
  if (!batch || batch.sourceRelease !== input.sourceRelease || batch.status !== 'canonical_journal_export'
      || !Array.isArray(batch.recordsByHand) || batch.recordsByHand.length !== input.cases.length)
    return {status:'unknown',reason:'journal_source_or_shape_mismatch',sourceRelease:input.sourceRelease};
  const cases = input.cases.map((c, index) => {
    try {
      const entry = batch.recordsByHand[index];
      if (!entry || entry.handKey !== c.handKey || !Array.isArray(entry.records)
          || !entry.records.length || entry.records.length > 256) return unknown(c,'journal_missing_or_bounds');
      const coordinate = `${c.tableId}:${c.handNumber}:${c.leaseGeneration}`;
      const accepted = [], decisions = [], seen = new Set();
      for (const r of entry.records) {
        api.validateHorseJournalRecord(r);
        if (r.handKey !== c.handKey || r.sourceRelease !== input.sourceRelease || seen.has(r.eventId))
          return unknown(c,'record_binding_or_duplicate');
        seen.add(r.eventId);
        const body = JSON.parse(r.body);
        if (r.kind === 'accepted_hand') {
          if (body.committedHandId !== c.handId || api.horseCompletedHandKey(body) !== coordinate)
            return unknown(c,'accepted_hand_binding_mismatch');
          accepted.push(r);
        }
        if (r.kind !== 'decision') continue;
        const s = body.snapshot, anchor = api.anchorHorseDecisionHand(s);
        if (anchor.status !== 'anchored' || api.horseHandAnchorKey(anchor) !== coordinate)
          return unknown(c,'original_snapshot_binding_mismatch');
        const mismatch = api.horsePhase6AttributionMismatch(body.decision,s);
        if (mismatch === 'reference_shape' && Math.abs(r.atMs-Date.parse(c.errorAt)) <= 2000)
          decisions.push({r,body});
      }
      if (accepted.length !== 1) return unknown(c,'accepted_hand_missing_or_ambiguous');
      if (decisions.length !== 1) return unknown(c,decisions.length ? 'matching_decision_ambiguous' : 'matching_decision_missing');
      const {r,body} = decisions[0], s = body.snapshot, g = s.gameState, p = s.player;
      const ref = body.decision.tournamentPreflopAttribution;
      if (!routes.has(ref.route) || !actions.has(ref.referenceProposal.action)
          || !actions.has(body.decision.action)) return unknown(c,'decision_shape_unknown');
      const history = (g.actionHistory || []).filter(a=>a.stage==='preflop');
      const raises = history.filter(a=>a.action==='raise'||a.action==='bet'||(a.action==='all_in'&&a.isFullRaise!==undefined));
      const last = raises.at(-1)?.seat, raiser = g.players.find(x=>x.seat===last);
      const call = Math.min(Math.max(0,g.currentBet-p.bet),p.stack);
      const tournamentMode = g.gameMode ? g.gameMode==='tournament' : g.tournament!=null || (g.bigBlind??0)>=10;
      const nlhPreflop = g.gameVariant==='nlh' && g.stage==='preflop';
      const otherResponder = g.players.some(x=>!x.is_folded&&!x.is_sitting_out&&!x.is_all_in&&x.stack>0&&x.seat!==p.seat&&x.seat!==last);
      const shortStackDepth = Number.isFinite(api.shortStackNoFlatBb) && api.shortStackNoFlatBb>0
        && g.bigBlind>0 && (p.stack+(p.bet||0))/g.bigBlind<=api.shortStackNoFlatBb;
      const publicShortJam = tournamentMode && nlhPreflop && !!raiser && raiser.is_all_in!==true && call<p.stack && shortStackDepth;
      return {handKey:c.handKey,status:'observed',sourceRelease:r.sourceRelease,recordSha256:r.sha256,
        acceptedRecordSha256:accepted[0].sha256,decisionKeySha256:typeof s.decisionKey==='string'?hash(s.decisionKey):null,
        mismatch:'reference_shape',route:ref.route,referenceAction:ref.referenceProposal.action,returnedAction:body.decision.action,
        diagnosis:ref.route==='variant_price'&&ref.referenceProposal.action==='all_in'&&publicShortJam
          ? 'short_stack_variant_jam_public_shape' : 'unclassified_reference_shape',
        guards:{recordHashVerified:true,originalHandBound:true,timestampNearError:true,tournamentMode,nlhPreflop,
          shortStackDepth,raiserPresent:!!raiser,raiserAllIn:raiser?.is_all_in===true,callBelowStack:call<p.stack,
          oldJamStackRatio:p.stack>call*1.5,oldJamOtherResponder:otherResponder,exactlyTwoRaises:raises.length===2,
          pressureEnabled:(s.opts?.v53Pressure??true)!==false,mindEnabled:s.opts?.mind!==false}};
    } catch { return unknown(c,'record_or_validator_unavailable'); }
  });
  return {status:cases.every(c=>c.status==='observed')?'observed':'unknown',sourceRelease:input.sourceRelease,cases,
    rawRecordsExported:false,replayVerified:false,activationAllowed:false};
}
// Version 2 observes one explicitly named successful decision. The original
// reconciler owns the complete capture/execution/read-frame join, not this report.
export function inspectAcceptedCalloffRecords(input, batch, api) {
  const unknown = (c, reason) => ({handKey:c.handKey,status:'unknown',reason});
  if (!batch || batch.sourceRelease !== input.sourceRelease || batch.status !== 'canonical_journal_export'
      || !Array.isArray(batch.recordsByHand) || batch.recordsByHand.length !== input.cases.length)
    return {status:'unknown',reason:'journal_source_or_shape_mismatch',sourceRelease:input.sourceRelease};
  const cases=input.cases.map((c,index)=>{
    try {
      const entry=batch.recordsByHand[index], coordinate=`${c.tableId}:${c.handNumber}:${c.leaseGeneration}`;
      if (!entry || entry.handKey!==c.handKey || !Array.isArray(entry.records)
          || !entry.records.length || entry.records.length>256) return unknown(c,'journal_missing_or_bounds');
      const seen=new Set(), decisions=[], executions=[], accepted=[];
      for (const r of entry.records) {
        api.validateHorseJournalRecord(r);
        if (r.handKey!==c.handKey || r.sourceRelease!==input.sourceRelease || seen.has(r.eventId))
          return unknown(c,'record_binding_or_duplicate');
        seen.add(r.eventId);
        if (r.kind==='decision' && (c.decisionRecordSha256===null || r.sha256===c.decisionRecordSha256)) {
          const d=JSON.parse(r.body), p=d.snapshot?.player, g=d.snapshot?.gameState, ref=d.decision?.tournamentPreflopAttribution;
          if (c.decisionRecordSha256!==null || (d.decision?.action==='all_in' && ref?.route==='variant_price'
              && ref.referenceProposal?.action==='all_in' && ref.referenceProposal.amount===null
              && Number.isFinite(p?.stack) && p.stack>0 && Number.isFinite(g?.currentBet)
              && Number.isFinite(p.bet) && g.currentBet-p.bet>=p.stack)) decisions.push(r);
        }
        if (r.kind==='execution') executions.push(r);
        if (r.kind==='accepted_hand') accepted.push(r);
      }
      if (accepted.length!==1) return unknown(c,'accepted_hand_missing_or_ambiguous');
      if (decisions.length!==1) return unknown(c,decisions.length?'matching_decision_ambiguous':'matching_decision_missing');
      const r=decisions[0], body=JSON.parse(r.body), s=body.snapshot, p=s.player, g=s.gameState;
      const hand=JSON.parse(accepted[0].body), anchor=api.anchorHorseDecisionHand(s);
      if (hand.committedHandId!==c.handId || api.horseCompletedHandKey(hand)!==coordinate
          || accepted[0].turnKey!==c.handKey) return unknown(c,'accepted_hand_binding_mismatch');
      if (anchor.status!=='anchored' || api.horseHandAnchorKey(anchor)!==coordinate)
        return unknown(c,'original_snapshot_binding_mismatch');
      const ref=body.decision.tournamentPreflopAttribution;
      const toCall=Math.max(0,g.currentBet-p.bet);
      if (body.decision.action!=='all_in' || !ref || ref.route!=='variant_price' || ref.referenceProposal?.action!=='all_in'
          || ref.referenceProposal.amount!==null || !Number.isFinite(p.stack) || !(p.stack>0)
          || !Number.isFinite(toCall) || !(toCall>=p.stack)) return unknown(c,'calloff_shape_not_observed');
      if (api.horsePhase6AttributionMismatch(body.decision,s)!==null
          || !api.horseDecisionReceiptIsValid(body.decision,g.gameVariant,{player:p,gameState:g}))
        return unknown(c,'calloff_receipt_refused');
      const sameTurn=executions.filter(e=>e.turnKey===r.turnKey && e.producerId===r.producerId);
      if (sameTurn.length!==1) return unknown(c,'calloff_execution_missing_or_ambiguous');
      const e=sameTurn[0], w=JSON.parse(e.body);
      if (r.sequence>=e.sequence || w.executionStatus!=='intended' || w.retirementReason!==null
          || w.policyFallback==='brain_exception' || w.selected?.action!=='all_in'
          || w.executedAction!=='all_in' || w.acceptedActions?.length!==1
          || w.acceptedActions[0].intended!==true || w.acceptedActions[0].record.action!=='all_in'
          || api.bindHorseDecisionToCommittedHand(w,hand).status!=='bound')
        return unknown(c,'calloff_execution_not_intended');
      const review=api.reconcileHorseJournalHand(entry.records,c.handKey);
      if (review.status!=='reconciled' || review.gaps.length || !(review.matchedActions>0)
          || review.matchedActions!==review.acceptedHorseActions)
        return unknown(c,'calloff_hand_not_reconciled');
      return {handKey:c.handKey,status:'observed',sourceRelease:r.sourceRelease,
        observation:'accepted_variant_price_whole_stack_calloff',decisionRecordSha256:r.sha256,
        executionRecordSha256:e.sha256,acceptedRecordSha256:accepted[0].sha256,
        decisionKeySha256:hash(s.decisionKey),guards:{recordHashVerified:true,originalHandBound:true,
          exactDecisionBound:true,positiveStackCalloff:true,receiptValid:true,sameTurnExecution:true,
          intendedAllInAccepted:true,handReconciled:true}};
    } catch {return unknown(c,'record_or_validator_unavailable');}
  });
  return {version:2,status:cases.every(c=>c.status==='observed')?'observed':'unknown',
    sourceRelease:input.sourceRelease,cases,rawRecordsExported:false,replayVerified:false,activationAllowed:false};
}
if (process.argv[1] === '--reference-shape-diagnostic') {
  try {
    let raw=''; for await (const c of process.stdin) {raw+=c; if(Buffer.byteLength(raw)>8192)throw Error();}
    const input=JSON.parse(raw);
    const journal=await import('/app/dist/services/horseCorrectiveReview/journalTransport.js');
    const records=await import('/app/dist/services/horseDecisionJournal/record.js');
    const binding=await import('/app/dist/engine/HorseDecisionHandBinding.js');
    const phase6=await import('/app/dist/engine/HorsePhase6Attribution.js');
    const logic=await import('/app/dist/engine/HorseLogic.js');
    // Match the existing private export CLI: this finite child owns no lobby timer.
    const {channelHub}=await import('/app/dist/hub/ChannelHub.js'); channelHub.close();
    const batch=journal.exportCanonicalHorseJournalBatch(input.cases.map(c=>c.handKey),process.env);
    if (input.version===2) {
      const review=await import('/app/dist/services/horseDecisionJournal/review.js');
      const validation=await import('/app/dist/engine/horseDecision/responseValidation.js');
      console.log(JSON.stringify(inspectAcceptedCalloffRecords(input,batch,{...records,...binding,...phase6,...review,...validation})));
    } else console.log(JSON.stringify(inspectReferenceRecords(input,batch,{...records,...binding,...phase6,shortStackNoFlatBb:logic.SHORT_STACK_NO_FLAT_BB})));
  } catch {console.log(JSON.stringify({status:'unknown',reason:'journal_or_runtime_unavailable'}));}
  process.exit(0);
}
'''


def sanitize_positive_calloff_result(result, value):
    reasons = {'journal_source_or_shape_mismatch', 'journal_missing_or_bounds',
               'record_binding_or_duplicate', 'accepted_hand_binding_mismatch',
               'original_snapshot_binding_mismatch', 'accepted_hand_missing_or_ambiguous',
               'matching_decision_ambiguous', 'matching_decision_missing',
               'record_or_validator_unavailable', 'journal_or_runtime_unavailable',
               'calloff_shape_not_observed', 'calloff_receipt_refused',
               'calloff_execution_missing_or_ambiguous', 'calloff_execution_not_intended',
               'calloff_hand_not_reconciled'}
    if not isinstance(result, dict) or result.get('status') not in ('unknown', 'observed'):
        raise ValueError()
    if 'cases' not in result:
        if (not set(result) <= {'status', 'reason', 'sourceRelease'} or result.get('status') != 'unknown'
                or result.get('reason') not in reasons
                or ('sourceRelease' in result and result['sourceRelease'] != value['sourceRelease'])):
            raise ValueError()
        return result
    if (set(result) != {'version', 'status', 'sourceRelease', 'cases', 'rawRecordsExported', 'replayVerified', 'activationAllowed'}
            or type(result['version']) is not int or result['version'] != 2
            or result['sourceRelease'] != value['sourceRelease']
            or any(result[k] is not False for k in ('rawRecordsExported', 'replayVerified', 'activationAllowed'))
            or not isinstance(result['cases'], list) or len(result['cases']) != len(value['cases'])):
        raise ValueError()
    hashes = {'decisionRecordSha256', 'executionRecordSha256', 'acceptedRecordSha256', 'decisionKeySha256'}
    guard_keys = {'recordHashVerified', 'originalHandBound', 'exactDecisionBound', 'positiveStackCalloff',
                  'receiptValid', 'sameTurnExecution', 'intendedAllInAccepted', 'handReconciled'}
    for case, original in zip(result['cases'], value['cases']):
        if not isinstance(case, dict) or case.get('handKey') != original['handKey']:
            raise ValueError()
        if case.get('status') == 'unknown':
            if set(case) != {'handKey', 'status', 'reason'} or case.get('reason') not in reasons:
                raise ValueError()
            continue
        if (set(case) != {'handKey', 'status', 'sourceRelease', 'observation', 'guards'} | hashes
                or case['status'] != 'observed' or case['sourceRelease'] != value['sourceRelease']
                or case['observation'] != 'accepted_variant_price_whole_stack_calloff'
                or (original['decisionRecordSha256'] is not None and case['decisionRecordSha256'] != original['decisionRecordSha256'])
                or any(not isinstance(case[k], str) or not re.fullmatch(r'[0-9a-f]{64}', case[k]) for k in hashes)
                or not isinstance(case['guards'], dict) or set(case['guards']) != guard_keys
                or any(v is not True for v in case['guards'].values())):
            raise ValueError()
    if (result['status'] == 'observed') != all(c['status'] == 'observed' for c in result['cases']):
        raise ValueError()
    return result


def sanitize_reference_result(result, value):
    if value['version'] == 2:
        return sanitize_positive_calloff_result(result, value)
    unknown_reasons = {'journal_source_or_shape_mismatch', 'journal_missing_or_bounds',
                       'record_binding_or_duplicate', 'accepted_hand_binding_mismatch',
                       'original_snapshot_binding_mismatch', 'accepted_hand_missing_or_ambiguous',
                       'matching_decision_ambiguous', 'matching_decision_missing',
                       'decision_shape_unknown', 'record_or_validator_unavailable',
                       'journal_or_runtime_unavailable'}
    if not isinstance(result, dict) or result.get('status') not in ('unknown', 'observed'):
        raise ValueError()
    if 'cases' not in result:
        if (not set(result) <= {'status', 'reason', 'sourceRelease'}
                or result['status'] != 'unknown' or result.get('reason') not in unknown_reasons
                or ('sourceRelease' in result and result['sourceRelease'] != value['sourceRelease'])):
            raise ValueError()
        return result
    if (set(result) != {'status', 'sourceRelease', 'cases', 'rawRecordsExported', 'replayVerified', 'activationAllowed'}
            or result['sourceRelease'] != value['sourceRelease']
            or any(result[k] is not False for k in ('rawRecordsExported', 'replayVerified', 'activationAllowed'))
            or not isinstance(result['cases'], list) or len(result['cases']) != len(value['cases'])):
        raise ValueError()
    observed_keys = {'handKey', 'status', 'sourceRelease', 'recordSha256', 'acceptedRecordSha256',
                     'decisionKeySha256', 'mismatch', 'route', 'referenceAction', 'returnedAction', 'diagnosis', 'guards'}
    guard_keys = {'recordHashVerified', 'originalHandBound', 'timestampNearError', 'tournamentMode', 'nlhPreflop',
                  'shortStackDepth', 'raiserPresent', 'raiserAllIn', 'callBelowStack', 'oldJamStackRatio',
                  'oldJamOtherResponder', 'exactlyTwoRaises', 'pressureEnabled', 'mindEnabled'}
    for case, original in zip(result['cases'], value['cases']):
        if not isinstance(case, dict) or case.get('handKey') != original['handKey']:
            raise ValueError()
        if case.get('status') == 'unknown':
            if set(case) != {'handKey', 'status', 'reason'} or case.get('reason') not in unknown_reasons:
                raise ValueError()
            continue
        if (set(case) != observed_keys or case['status'] != 'observed'
                or case['sourceRelease'] != value['sourceRelease'] or case['mismatch'] != 'reference_shape'
                or case['route'] not in ('legacy_preflop', 'chart_open_jam', 'chart_bb_defend', 'variant_price', 'intent_engine')
                or any(case[k] not in ('fold', 'check', 'call', 'bet', 'raise', 'all_in')
                       for k in ('referenceAction', 'returnedAction'))
                or case['diagnosis'] not in ('short_stack_variant_jam_public_shape', 'unclassified_reference_shape')
                or any(not isinstance(case[k], str) or not re.fullmatch(r'[0-9a-f]{64}', case[k])
                       for k in ('recordSha256', 'acceptedRecordSha256'))
                or (case['decisionKeySha256'] is not None and
                    (not isinstance(case['decisionKeySha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', case['decisionKeySha256'])))
                or not isinstance(case['guards'], dict) or set(case['guards']) != guard_keys
                or any(type(v) is not bool for v in case['guards'].values())
                or any(case['guards'][k] is not True for k in ('recordHashVerified', 'originalHandBound', 'timestampNearError'))):
            raise ValueError()
    if (result['status'] == 'observed') != all(c['status'] == 'observed' for c in result['cases']):
        raise ValueError()
    return result


def reference_diagnostic(value):
    try:
        raw = bounded_command(['docker', 'exec', '-i', CONTAINER, 'node', '--input-type=module', '--max-old-space-size=128',
                               '-e', REFERENCE_DIAGNOSTIC_JS, '--', '--reference-shape-diagnostic'],
                              input_bytes=json.dumps(value).encode('utf-8'))
        # Parse without printing untrusted child output, including import errors.
        result = json.loads(raw)
        return sanitize_reference_result(result, value)
    except Exception:
        return {'status': 'unknown', 'reason': 'journal_or_runtime_unavailable'}
EVENTS = (
    'sng_atomic_creation_failed', 'spin_atomic_creation_failed',
    'sng_atomic_identity_mismatch', 'spin_atomic_identity_mismatch',
    'board_error', 'board_read_failed', 'board_joinability_read_failed',
    'sng_tick_failed', 'spin_tick_failed', 'initial_sng_tick_failed',
    'initial_spin_tick_failed', 'spin_owners_read_failed', 'SNG_creation_failed',
    'SNG_atomic_table_missing', 'createSNG_error', 'createSpin_error',
    'Spin_state_update_failed_for_s', 'SNG_state_update_failed_for_sn',
    'seat_first_seat_rpc_failed', 'seat_first_roster_read_failed',
    'horse_fleet_read_failed', 'horse_load_seats_failed',
    'horse_load_registrations_failed', 'bankroll_gate',
    'top_up_refused_fleet_held', 'top_up_refused_pool_finalized',
)
LITERALS = {
    'service_started': 'Service started - MTTs every 5 min',
    'register_no_candidates': 'registerHorses found no candidates:',
    'seat_first_no_fill': 'seat-first fill added nobody',
    'seat_first_precheck': 'seat-first-precheck ',
    'seat_first_rpc_noop': 'the seat RPC answered ok:false',
    'board_tick_overlap': 'board tick still running - skipping this one',
    'board_opened': 'Opened ',
    'held_empty': 'held-empty:',
}
CATEGORIES = ('insufficient_chips', 'insufficient_balance', 'fleet_held',
              'table_full', 'maintenance_frozen', 'permission denied',
              'statement timeout', 'deadlock detected', 'null value in column',
              'does not exist', 'no candidates', 'fleet read incomplete',
              'SEAT_FIRST_CREATE_INVALID_REQUEST', 'SEAT_FIRST_CREATE_UNKNOWN_CONFIG_KEY',
              'SEAT_FIRST_CREATE_INVALID_CONFIG', 'SEAT_FIRST_CREATE_INVALID_BLINDS',
              'SEAT_FIRST_CREATE_IDEMPOTENCY_MISMATCH', 'SEAT_FIRST_ATOMIC_PARTIAL_STATE',
              'platform_frozen', 'invalid response')
COUNT_LABELS = ('fleet', 'at-capacity/entered', 'not-a-club-member',
                'lane/window-excluded', 'shortfall', 'rpc_called', 'skipped_already_seated',
                'skipped_table_full', 'verify_reads', 'seated', 'rpc_already_seated',
                'rpc_table_full', 'rpc_refused', 'rpc_other_noop')


def summarize(raw):
    result = {}
    active = []
    origin = None
    continuation_budget = 0
    seen_categories = {}
    seen_codes = {}
    classified = set()
    for line in raw.splitlines():
        if len(line) > 4096:
            active = []
            continue
        stamp = re.match(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z\s', line)
        event_time = None
        if stamp:
            try:
                event_time = datetime.datetime.fromisoformat(stamp.group(1) + '+00:00')
            except ValueError:
                pass
        payload = line[stamp.end():] if stamp else line
        if re.search(r'\[TournamentRecurring(?:\]|\.)', payload):
            keys = [key for key, text in LITERALS.items() if text in payload]
            keys += [key for key in EVENTS if re.search(r'TournamentRecurring\.' + re.escape(key) + r'(?![A-Za-z0-9_])', payload)]
            active = list(set(keys))
            origin = event_time
            continuation_budget = 12
            seen_categories = {key: set() for key in active}
            seen_codes = {key: set() for key in active}
            classified = set()
            for key in active:
                entry = result.setdefault(key, {'count': 0, 'unclassifiedCount': 0, 'lastTimestamp': None, 'sqlstates': {}, 'categories': {}, 'counts': {}})
                entry['count'] += 1
                entry['unclassifiedCount'] += 1
                if event_time:
                    entry['lastTimestamp'] = stamp.group(1) + 'Z'
        else:
            # Node console.error(context, Error) prints indented stack/property
            # continuations. Only immediate timestamped lines within two seconds
            # and twelve records can classify the original event. Never print them.
            if not active or not origin or not event_time or continuation_budget <= 0 or not 0 <= (event_time - origin).total_seconds() <= 2 or not payload.startswith((' ', '\t')) or payload.lstrip().startswith('['):
                active = []
                continue
            continuation_budget -= 1
        for key in active:
            entry = result[key]
            codes = set(re.findall(r'(?:SQLSTATE[=: ]+|code[=: ]+[\"\x27]?)([0-9A-Z]{5})(?![0-9A-Z])', payload))
            codes &= {'22023', '22P02', '23502', '23503', '23505', '23514', '42501', '42703', '42883', '40P01', '57014', '55000'}
            categories = {category for category in CATEGORIES if re.search(r'(?<![A-Za-z0-9_])' + re.escape(category) + r'(?![A-Za-z0-9_])', payload)}
            if (codes or categories) and key not in classified:
                entry['unclassifiedCount'] -= 1
                classified.add(key)
            for code in codes - seen_codes[key]:
                entry['sqlstates'][code] = entry['sqlstates'].get(code, 0) + 1
            seen_codes[key].update(codes)
            for category in categories - seen_categories[key]:
                entry['categories'][category] = entry['categories'].get(category, 0) + 1
            seen_categories[key].update(categories)
            for label in COUNT_LABELS:
                match = re.search(r'(?<![A-Za-z0-9_/-])' + re.escape(label) + r'[ =](\d{1,7})(?!\d)', payload)
                if match:
                    entry['counts'][label] = int(match.group(1))
    return result


def read_metadata(raw):
    records = raw.splitlines()
    stamps = []
    for line in records:
        match = re.match(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)\s', line)
        if not match:
            continue
        try:
            parsed = datetime.datetime.fromisoformat(match.group(1).replace('Z', '+00:00'))
        except ValueError:
            continue
        stamps.append((parsed, match.group(1)))
    return {
        'semantics': 'bounded-tail',
        'recordsRead': len(records),
        'timestampedRecords': len(stamps),
        'oldestTimestamp': min(stamps)[1] if stamps else None,
        'newestTimestamp': max(stamps)[1] if stamps else None,
        'tailLimitReached': len(records) >= 10000,
        'full45MinuteCoverageProven': False,
        'healthyRefillProven': False,
    }


def worker_receipt_errors(raw):
    """Only the original reporter's table context and named refusal leave here.

    The Error currently carries no request/hand coordinate. Do not borrow one
    from a nearby gameplay line, error property, stack or another table.
    """
    result = {'matchingRecords': 0, 'events': [], 'eventsTruncated': False,
              'handCoordinateAvailable': False}
    expression = re.compile(
        r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)\s+'
        r'\[ServerTableEngine\.([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-'
        r'[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'
        r'\.horse_decision_worker_failed\] Error: '
        r'horse decision worker returned invalid policy receipt: reference_shape\s*$')
    for line in raw.splitlines():
        if len(line) > 4096:
            continue
        match = expression.fullmatch(line)
        if not match:
            continue
        try:
            datetime.datetime.fromisoformat(match.group(1).replace('Z', '+00:00'))
        except ValueError:
            continue
        result['matchingRecords'] += 1
        event = {'timestamp': match.group(1), 'code': 'reference_shape',
                 'tableId': match.group(2).lower()}
        # Retain the newest bounded witnesses in input order. Coverage remains
        # the existing bounded stream/tail, never an all-errors claim.
        if len(result['events']) == 128:
            result['events'].pop(0)
            result['eventsTruncated'] = True
        result['events'].append(event)
    return result


def tournament_yields(raw):
    """Only the original successful tournament-departure event, never nearby text.

    Prefixes are the reporter's actual eight hex characters, not full IDs.
    A pending hand-boundary leave is not a completed cashout receipt.
    """
    result = {'matchingRecords': 0, 'events': [], 'eventsTruncated': False,
              'cashoutCompletionProven': False}
    expression = re.compile(
        r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z) '
        r'\[SessionRotator\] horse=([0-9a-f]{8}) leaving table=([0-9a-f]{8}) '
        r'for a tournament in ([0-9]{1,3}) min '
        r'\((certain|hazard_fired), ([1-9][0-9]{0,2}) over four games\)$')
    for line in raw.splitlines():
        if len(line) > 4096:
            continue
        match = expression.fullmatch(line)
        if not match:
            continue
        try:
            datetime.datetime.fromisoformat(match.group(1).replace('Z', '+00:00'))
        except ValueError:
            continue
        result['matchingRecords'] += 1
        if len(result['events']) == 128:
            result['events'].pop(0)
            result['eventsTruncated'] = True
        result['events'].append({'timestamp': match.group(1),
            'horseIdPrefix': match.group(2), 'tableIdPrefix': match.group(3),
            'minutesToStart': int(match.group(4)), 'reason': match.group(5),
            'excess': int(match.group(6))})
    return result


def merge_tournament_yields(target, addition):
    target['matchingRecords'] += addition['matchingRecords']
    combined = target['events'] + addition['events']
    target['eventsTruncated'] = (target['eventsTruncated'] or
                                addition['eventsTruncated'] or len(combined) > 128)
    target['events'] = combined[-128:]


def merge_worker_receipt_errors(target, addition):
    target['matchingRecords'] += addition['matchingRecords']
    combined = target['events'] + addition['events']
    target['eventsTruncated'] = (target['eventsTruncated'] or
                                addition['eventsTruncated'] or len(combined) > 128)
    target['events'] = combined[-128:]


def bounded_command(args, input_bytes=None):
    process = subprocess.Popen(args, stdin=subprocess.PIPE if input_bytes is not None else None,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    payload = bytearray()
    deadline = time.monotonic() + 25
    try:
        if input_bytes is not None:
            process.stdin.write(input_bytes)
            process.stdin.close()
        while True:
            if time.monotonic() >= deadline:
                raise RuntimeError('read_deadline')
            ready = selector.select(min(1, max(0, deadline - time.monotonic())))
            if not ready:
                continue
            chunk = process.stdout.read1(65536)
            if not chunk:
                break
            payload.extend(chunk)
            if len(payload) > MAX_BYTES:
                raise RuntimeError('read_size_bound')
        if process.wait(timeout=2) != 0:
            raise RuntimeError('read_command_refused')
        return payload.decode('utf-8', errors='replace')
    finally:
        selector.close()
        process.stdout.close()
        if process.poll() is None:
            process.kill()  # Only this read-only diagnostic child, never the engine.
            process.wait(timeout=2)


def identity(expected):
    # Docker's immutable selection is available even while Node is down. Never
    # make healthy service a prerequisite for diagnosing why service is down.
    raw = bounded_command(['docker', 'container', 'inspect', '-f',
        '{{.Id}} {{.Image}} {{index .Config.Labels "sp.release.sha"}}', CONTAINER]).strip()
    fields = raw.split()
    if (len(fields) != 3 or not re.fullmatch(r'[0-9a-f]{64}', fields[0])
            or not re.fullmatch(r'sha256:[0-9a-f]{64}', fields[1]) or fields[2] != expected):
        raise RuntimeError('container_identity_refused')
    result = {'containerId': fields[0], 'imageId': fields[1], 'health': 'unavailable',
              'instanceId': None}
    request = urllib.request.Request('http://127.0.0.1:8080/health', headers={'Cache-Control': 'no-cache, no-store'})
    try:
        try:
            response = urllib.request.urlopen(request, timeout=10)
        except urllib.error.HTTPError as error:
            # /health deliberately answers 503 on standby and degraded states.
            if error.code != 503:
                return result
            response = error
        with response:
            body = response.read(65537)
        if len(body) > 65536:
            raise RuntimeError('health_size_bound')
        health = json.loads(body)
    except (urllib.error.URLError, TimeoutError, OSError):
        return result
    except (ValueError, TypeError):
        result['health'] = 'unreadable'
        return result
    if not isinstance(health, dict):
        result['health'] = 'unreadable'
        return result
    if health.get('releaseSha') != expected:
        raise RuntimeError('health_identity_refused')
    instance = health.get('instanceId')
    if not isinstance(instance, str) or not re.fullmatch(r'[1-9][0-9]*-[0-9a-f]{8}', instance):
        raise RuntimeError('health_identity_refused')
    result['instanceId'] = instance
    result['health'] = health.get('liveness') if health.get('liveness') in ('ok', 'standby', 'dead') else 'degraded'
    return result


PROCESS_SIGNALS = {
    'fatal_uncaught': '[GameServer] FATAL (GameServer.Uncaught_exception)',
    'fatal_rejection': '[GameServer] FATAL (GameServer.Unhandled_rejection)',
    'fatal_boot': '[GameServer] FATAL (GameServer.Fatal_error)',
    'shutdown_requested': '[GameServer] Received shutdown signal',
    'shutdown_fleet_started': '[GameServer] Shutting down...',
    'shutdown_horse_fleet_stopped': '[HorseFleet] Stopped',
    'shutdown_scheduled_stopped': '[ScheduledTournaments] Stopped',
    'shutdown_recurring_stopped': '[TournamentRecurring] Stopped',
    'shutdown_lifecycle_stopped': '[Lifecycle] Stopped',
    'shutdown_settler_stopped': '[RakebackSettler] Stopped',
    'shutdown_tables_drained': '[GameServer] Drained all ',
    'shutdown_table_drain_elapsed': '[GameServer] Drain window elapsed with ',
    'shutdown_ownership_complete': '[GameServer] Shutdown complete.',
    'shutdown_deadline': '[GameServer] graceful shutdown exceeded',
    'shutdown_failed': '[GameServer] GameServer.shutdown_failed',
    'leadership_lost': '[leadership] LOST LEADERSHIP',
    'standby_promoted': 'but booted as a standby, so it has',
    'v8_heap_exhausted': 'FATAL ERROR: Reached heap limit',
    'v8_ineffective_gc': 'FATAL ERROR: Ineffective mark-compacts near heap limit',
}
PROCESS_CONTEXTS = ('GameServer.Uncaught_exception', 'GameServer.Unhandled_rejection',
    'GameServer.Fatal_error', 'GameServer.shutdown_deadline', 'GameServer.shutdown_failed',
    'Leadership.lost', 'Leadership.shutdown_failed', 'Tournament.abandoned_generation_refused')
PROCESS_CAUSES = ('F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT', 'F06_ABANDONED_ROSTER_CHANGED',
    'F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION', 'F06_ABANDONED_PARK_CHANGED',
    'worker execution deadline', 'worker exited', 'out of memory', 'heap out of memory',
    'statement timeout', 'deadlock detected', 'fetch failed', 'ECONNRESET', 'ETIMEDOUT',
    'execution deadline after dispatch', 'live horse decision worker exited with code',
    'live horse decision worker READY timed out', 'Cannot read properties of undefined')


PROCESS_FRAMES = {'index.js', 'GameServer.js', 'services/leadership.js',
    'engine/horseDecision/client.js', 'engine/LiveHorseDecisionWorkerHealth.js',
    'engine/EquityWorkerPool.js', 'services/supabase/client.js'}


def process_signals(raw):
    result = {}
    active = None
    remaining = 0
    for line in raw.splitlines():
        if len(line) > 4096:
            active = None
            continue
        stamp = re.match(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z\s', line)
        if not stamp:
            active = None
            continue
        try:
            instant = datetime.datetime.fromisoformat(stamp.group(1) + '+00:00')
        except ValueError:
            active = None
            continue
        payload = line[stamp.end():]
        keys = [key for key, literal in PROCESS_SIGNALS.items() if literal in payload]
        keys += [key for key in PROCESS_CONTEXTS if payload.startswith('[' + key + ']')]
        if keys:
            active = (keys, instant)
            remaining = 12
            for key in keys:
                entry = result.setdefault(key, {'count': 0, 'lastTimestamp': None, 'causes': {}, 'frames': []})
                entry['count'] += 1
                entry['lastTimestamp'] = stamp.group(1) + 'Z'
        elif (not active or remaining <= 0 or not payload.startswith((' ', '\t'))
              or not 0 <= (instant - active[1]).total_seconds() <= 2):
            active = None
        else:
            remaining -= 1
        if active:
            for key in active[0]:
                for path, number in re.findall(r'/app/dist/([A-Za-z0-9_./-]+\.js):(\d{1,7}):\d{1,5}', payload):
                    if path not in PROCESS_FRAMES:
                        continue
                    frame = {'path': path, 'line': int(number)}
                    frames = result[key]['frames']
                    if frame not in frames and len(frames) < 8:
                        frames.append(frame)
                for cause in PROCESS_CAUSES:
                    if re.search(r'(?<![A-Za-z0-9_])' + re.escape(cause) + r'(?![A-Za-z0-9_])', payload):
                        counts = result[key]['causes']
                        counts[cause] = counts.get(cause, 0) + 1
    return result


def merge_signals(target, addition):
    for key, value in addition.items():
        entry = target.setdefault(key, {'count': 0, 'lastTimestamp': None, 'causes': {}, 'frames': []})
        entry['count'] += value['count']
        if value['lastTimestamp'] and (entry['lastTimestamp'] is None or value['lastTimestamp'] > entry['lastTimestamp']):
            entry['lastTimestamp'] = value['lastTimestamp']
        for cause, count in value['causes'].items():
            entry['causes'][cause] = entry['causes'].get(cause, 0) + count
        for frame in value['frames']:
            if frame not in entry['frames'] and len(entry['frames']) < 8:
                entry['frames'].append(frame)


def process_history(args=None, max_bytes=256 * 1024 * 1024, seconds=20):
    # Stream the retained history instead of truncating it at the newest 10k
    # noisy gameplay lines. Keep only one bounded error block in memory. Raw
    # lines are never returned, persisted or printed, even on read failure.
    args = args or ['docker', 'logs', '--since', '2h', '--timestamps', CONTAINER]
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + seconds
    signals = {}
    worker_errors = worker_receipt_errors('')
    yields = tournament_yields('')
    block = []
    pending = b''
    dropping = False
    total = 0
    records = 0
    oldest = None
    newest = None
    outcome = 'complete'
    markers = ('[GameServer.', '[GameServer] FATAL', '[GameServer] Received shutdown',
               '[GameServer] graceful shutdown', '[GameServer] GameServer.shutdown_failed', '[leadership]', '[Leadership.',
               '[Tournament.abandoned_generation_refused]', 'FATAL ERROR:', *PROCESS_SIGNALS.values())

    def flush_block():
        nonlocal block
        text = '\n'.join(block)
        merge_signals(signals, process_signals(text))
        merge_worker_receipt_errors(worker_errors, worker_receipt_errors(text))
        block = []

    def record(raw):
        nonlocal records, block, oldest, newest
        records += 1
        if len(raw) > 4096:
            if block:
                flush_block()
            return
        line = raw.decode('utf-8', errors='replace')
        if '[SessionRotator] horse=' in line:
            merge_tournament_yields(yields, tournament_yields(line))
        stamp = re.match(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z\s', line)
        if stamp:
            try:
                datetime.datetime.fromisoformat(stamp.group(1) + '+00:00')
                oldest = min(oldest, stamp.group(1)) if oldest else stamp.group(1)
                newest = max(newest, stamp.group(1)) if newest else stamp.group(1)
            except ValueError:
                pass
        if any(marker in line for marker in markers) or (
                '[ServerTableEngine.' in line and '.horse_decision_worker_failed]' in line):
            if block:
                flush_block()
            block = [line]
        elif block:
            block.append(line)
            if len(block) >= 13:
                flush_block()

    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                outcome = 'time_bound'
                break
            if not selector.select(min(0.2, remaining)):
                continue
            chunk = process.stdout.read1(65536)
            if not chunk:
                if pending and not dropping:
                    record(pending)
                if process.wait(timeout=2) != 0:
                    outcome = 'command_failed'
                break
            total += len(chunk)
            if total > max_bytes:
                outcome = 'size_bound'
                break
            parts = (pending + chunk).split(b'\n')
            pending = parts.pop()
            for line in parts:
                if dropping:
                    dropping = False
                    continue
                record(line)
            if len(pending) > 4096:
                pending = b''
                dropping = True
        if block:
            flush_block()
        return {'signals': signals, 'workerReceiptErrors': worker_errors,
                'tournamentYields': yields,
                'coverage': {'status': outcome,
                'bytesRead': total, 'recordsRead': records,
                'oldestTimestamp': oldest + 'Z' if oldest else None,
                'newestTimestamp': newest + 'Z' if newest else None,
                'fullTwoHourCoverageProven': False}}
    finally:
        selector.close()
        process.stdout.close()
        if process.poll() is None:
            process.kill()  # Only our read child; never the engine.
            process.wait(timeout=2)


def archived_process_history(directory='/var/log/club-arena-engine'):
    # The sole engine run-spec saves its outgoing logs here before a sealed
    # replacement. Read at most two recent regular archives; no arbitrary path,
    # shell expansion, environment file or runtime mutation is admitted.
    archives = []
    pattern = re.compile(r'engine-\d{8}T\d{6}Z-started\d{8}T\d{6}-([0-9a-f]{12})-([0-9a-f]{8})\.log\.gz')
    try:
        candidates = []
        for path in Path(directory).glob('engine-*.log.gz'):
            match = pattern.fullmatch(path.name)
            if not match or path.is_symlink() or not path.is_file():
                continue
            stamp = path.stat().st_mtime
            if 0 <= time.time() - stamp <= 2 * 60 * 60:
                candidates.append((stamp, path, match.group(1), match.group(2)))
        for _, path, container_prefix, image_prefix in sorted(candidates, reverse=True)[:2]:
            result = process_history(['gzip', '-cd', str(path)], seconds=10)
            archives.append({'imageIdPrefix': image_prefix, 'containerIdPrefix': container_prefix, **result})
        return {'status': 'observed', 'archives': archives, 'fullTwoHourCoverageProven': False}
    except Exception:
        return {'status': 'unavailable', 'archives': archives, 'fullTwoHourCoverageProven': False}


def kernel_oom_signals(raw, container_prefixes):
    events = []
    context_id = None
    context_time = None
    for line in raw.splitlines():
        if len(line) > 4096:
            continue
        stamp = re.match(r'^(\d{4}-\d{2}-\d{2}T[0-9:.,+-]+)\s', line)
        if not stamp:
            continue
        try:
            instant = datetime.datetime.fromisoformat(stamp.group(1).replace(',', '.'))
            if instant.tzinfo is None:
                continue
        except ValueError:
            continue
        container = re.search(r'(?:docker-|/docker/)([0-9a-f]{64})(?:\.scope|[/,\s])', line)
        if container:
            context_id = container.group(1)[:12]
            context_time = instant
        if not re.search(r'(?:Out of memory|Memory cgroup out of memory|oom-kill|Killed process)', line, re.IGNORECASE):
            continue
        pid = re.search(r'Killed process ([0-9]{1,10}) \(node\)', line)
        if not pid:
            continue
        same_context = context_time is not None and 0 <= (instant - context_time).total_seconds() <= 2
        prefix = context_id if same_context and context_id in container_prefixes else None
        events.append({'timestamp': instant.astimezone(datetime.timezone.utc).isoformat(),
                       'nodePid': int(pid.group(1)), 'engineContainerMatched': prefix is not None,
                       'containerIdPrefix': prefix})
        if len(events) >= 128:
            break
    return {'events': events, 'fullHistoryProven': False}


def autoheal_signals(raw, container_id):
    result = {}
    for line in raw.splitlines():
        if len(line) > 4096 or not (CONTAINER in line or container_id[:12] in line):
            continue
        stamp = re.match(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z\s', line)
        if not stamp:
            continue
        for key, expression in [('unhealthy', r'\bunhealthy\b'),
                                ('restart', r'\brestart(?:ing|ed)?\b'),
                                ('restart_failed', r'\b(?:failed|error)\b')]:
            if re.search(expression, line, re.IGNORECASE):
                entry = result.setdefault(key, {'count': 0, 'lastTimestamp': None})
                entry['count'] += 1
                entry['lastTimestamp'] = stamp.group(1) + 'Z'
    return result


def restart_evidence():
    # Explicit state fields only: never serialize Config.Env or arbitrary labels.
    raw = bounded_command(['docker', 'container', 'inspect', '-f',
        '{{json .State}}', CONTAINER])
    state = json.loads(raw)
    restarts = bounded_command(['docker', 'container', 'inspect', '-f',
        '{{.RestartCount}}', CONTAINER]).strip()
    events = bounded_command(['docker', 'events', '--since', '24h', '--until',
        datetime.datetime.now(datetime.timezone.utc).isoformat(),
        '--filter', 'type=container', '--filter', 'container=' + CONTAINER, '--format', '{{json .}}'])
    return sanitize_restart_evidence(state, restarts, events)


def sanitize_restart_evidence(state, restarts, raw_events):
    if not isinstance(state, dict) or not re.fullmatch(r'[0-9]{1,9}', restarts):
        raise RuntimeError('container_state_refused')
    result = {'oomKilled': state.get('OOMKilled') is True,
              'exitCode': state.get('ExitCode') if type(state.get('ExitCode')) is int else None,
              'restartCount': int(restarts), 'events': []}
    for line in raw_events.splitlines():
        event = json.loads(line)
        attrs = event.get('Actor', {}).get('Attributes', {})
        if attrs.get('name') != CONTAINER:
            continue
        action = event.get('Action')
        if action not in ('oom', 'die', 'restart', 'start', 'stop', 'kill'):
            continue
        stamp = event.get('time')
        if type(stamp) is not int:
            continue
        item = {'action': action, 'unixTime': stamp}
        for key in ('exitCode', 'signal'):
            value = attrs.get(key)
            if isinstance(value, str) and re.fullmatch(r'[0-9]{1,3}', value):
                item[key] = int(value)
        result['events'].append(item)
    return result


def main(expected, selected_cases=None):
    if not re.fullmatch(r'[0-9a-f]{40}', expected):
        raise RuntimeError('expected_sha_refused')
    before = identity(expected)
    original_cases = reference_diagnostic(selected_cases) if selected_cases is not None else None
    raw = bounded_command(['docker', 'logs', '--since', '45m', '--tail', '10000', '--timestamps', CONTAINER])
    events = summarize(raw)
    restarts = restart_evidence()
    history = process_history()
    archives = archived_process_history()
    try:
        kernel_raw = bounded_command(['dmesg', '--time-format', 'iso'])
        prefixes = {before['containerId'][:12]} | {a['containerIdPrefix'] for a in archives['archives']}
        kernel = {'status': 'observed', **kernel_oom_signals(kernel_raw, prefixes)}
    except Exception:
        kernel = {'status': 'unavailable', 'events': [], 'fullHistoryProven': False}
    try:
        autoheal_raw = bounded_command(['docker', 'logs', '--since', '2h', '--tail', '2000', '--timestamps', 'sp-autoheal'])
        autoheal = {'status': 'observed', 'signals': autoheal_signals(autoheal_raw, before['containerId'])}
    except Exception:
        autoheal = {'status': 'unavailable', 'signals': {}}
    after = identity(expected)
    if any(before[key] != after[key] for key in ('containerId', 'imageId')):
        raise RuntimeError('engine_changed_during_read')
    runtime_stable = before == after
    print(json.dumps({'schemaVersion': 1, 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'engineSha': expected, 'instanceId': before['instanceId'], 'identityBefore': before, 'identityAfter': after, 'runtimeStable': runtime_stable, 'windowMinutes': 45, 'tailLimit': 10000, 'events': events, 'restarts': restarts, 'processSignals': process_signals(raw), 'workerReceiptErrors': worker_receipt_errors(raw), 'tournamentYields': tournament_yields(raw), 'referenceCases': original_cases, 'processHistory': history, 'archivedProcessHistory': archives, 'kernelOom': kernel, 'autoheal': autoheal, 'coverage': read_metadata(raw), 'rawLogsExported': False, 'readOnly': True}, sort_keys=True))


def cli(argv):
    try:
        if len(argv) == 3 and argv[1] == '--encode-reference-cases':
            value = reference_cases(sys.stdin.buffer.read(REFERENCE_CASE_BYTES + 1), argv[2])
            print(base64.b64encode(json.dumps(value, separators=(',', ':')).encode('utf-8')).decode('ascii'))
            return 0
        if len(argv) not in (2, 3):
            raise RuntimeError('argument_refused')
        selected = None
        if len(argv) == 3 and argv[2]:
            if len(argv[2]) > 11000:
                raise ValueError('reference_cases_refused')
            selected = reference_cases(base64.b64decode(argv[2], validate=True), argv[1])
        main(argv[1], selected)
        return 0
    except Exception:
        # Never emit subprocess output, exception messages, URLs or log bodies.
        print('{"readOnly":true,"status":"diagnostic_refused","rawLogsExported":false}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(cli(sys.argv))
