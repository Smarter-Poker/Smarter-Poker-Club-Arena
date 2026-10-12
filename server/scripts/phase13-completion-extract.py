"""P13.3 completion reader, stage 1 (engine host, read-only).

Prints one JSON line per journaled betting decision of ONE joint variant, made
on ONE engine release, decided in [from, to):
{"eventId", "decisionTimeMs", "gameMode", "variant", "boardCount", "bombPot",
 "dealtPlayers", "governorScale", "receipt"} where receipt is
body.decision.jointPolicy as journaled (null when absent). Stage 2
(server/src/scripts/phase13CompletionRecord.ts) counts them with the
authority's own horsePhase13CompletionCounts and writes the
horse-phase13-completion-v1 record, so no counting rule lives here.

The joint owner decides single-board, multi-board and bomb hands alike, so
all three are printed (boardCount and bombPot say which). Diamond decisions are
printed too and named in the summary (diamond_records): stage 2 excludes them
from every cell by name (the record's excluded.diamond, completion definition
v2), because the P13.2 contract excludes Diamond NLH from the qualified domain.
Which counted field a decision falls under (completed, analysisUnavailable and
the rest) is decided in stage 2 only. Pineapple discards
are journaled as their own kind (discard_decision); they are never betting
decisions and are counted apart here, by name, windowed by the request's own
journalContext.requestedAtMs, never printed. Only DECIDE_FAST decision records
count: a DEEP second look is a second record for the same turn and is counted
apart by name.

Reads closed archive segment files only (never the live journal), verifying
each segment's sha256 name. Run under nice 19 / ionice idle.

argv: <from-iso> <to-iso> <release-sha40> <variant: one of the nine joint variants>
The window bounds are read exactly as stage 2's Date.parse reads these forms:
YYYY-MM-DDTHH:MM[:SS[.fraction]] followed by Z or +HH:MM / -HH:MM, the fraction
truncated to milliseconds. A bound without an offset (local time to
Date.parse) or in any other form is refused (exit 1, nothing printed).
stderr: a JSON summary (segments read, records, excluded by name).
env (tests only): PHASE13_EXTRACT_SEGMENT_DIRS, colon-separated segment
directories replacing the two host archive directories.
"""
import os, re, sys, gzip, json, hashlib, calendar
from collections import Counter

VARIANTS = ('nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'flo8', 'flh', 'pineapple', 'short_deck')
DIRS = ['/var/lib/club-arena/horse-decisions/archive/segments',
        '/var/lib/club-arena/horse-decisions/archive-shard-1/segments']
if os.environ.get('PHASE13_EXTRACT_SEGMENT_DIRS'):
    DIRS = os.environ['PHASE13_EXTRACT_SEGMENT_DIRS'].split(':')
frm, to, release, variant = sys.argv[1:5]
assert variant in VARIANTS and len(release) == 40
ISO = re.compile(r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$')
def ms(iso):
    # Date.parse for these forms: UTC epoch milliseconds, the fraction
    # truncated (never rounded) to milliseconds, the offset applied.
    m = ISO.match(iso)
    if not m:
        sys.exit('window bound is not an ISO-8601 time with an offset: %r' % iso)
    y, mo, d, h, mi, sec, frac, zone = m.groups()
    y, mo, d, h, mi, sec = int(y), int(mo), int(d), int(h), int(mi), int(sec or 0)
    if not (1 <= mo <= 12 and 1 <= d <= calendar.monthrange(y, mo)[1] and h <= 23 and mi <= 59 and sec <= 59):
        sys.exit('window bound is not a valid time: %r' % iso)
    offset = 0
    if zone != 'Z':
        oh, om = int(zone[1:3]), int(zone[4:6])
        if oh > 23 or om > 59:
            sys.exit('window bound offset is not valid: %r' % iso)
        offset = (oh * 60 + om) * 60000 * (1 if zone[0] == '+' else -1)
    millis = int(((frac or '') + '000')[:3])
    return calendar.timegm((y, mo, d, h, mi, sec, 0, 0, 0)) * 1000 + millis - offset
FROM, TO = ms(frm), ms(to)
summary = Counter()
for d in DIRS:
    for e in os.scandir(d):
        if not e.name.endswith('.ndjson.gz'): continue
        try:
            if e.stat().st_mtime * 1000 < FROM - 120000: continue
            raw = gzip.decompress(open(e.path, 'rb').read())
        except FileNotFoundError:
            summary['segment_retired_during_scan'] += 1; continue
        if hashlib.sha256(raw).hexdigest() != e.name[:-len('.ndjson.gz')]:
            summary['segment_digest_mismatch'] += 1; continue
        summary['segments_read'] += 1
        for line in raw.decode('utf-8').splitlines():
            r = json.loads(line)
            kind = r.get('kind')
            if kind not in ('decision', 'discard_decision'): continue
            body = json.loads(r['body'])
            s = body.get('snapshot') or {}
            if kind == 'discard_decision':
                # A discard snapshot is a DECIDE_DISCARD request: its variant is
                # top level and its time is the request's own (or the record's).
                ctx = s.get('journalContext') or {}
                at = ctx.get('requestedAtMs', r.get('atMs'))
                if isinstance(at, int) and FROM <= at < TO and s.get('gameVariant') == variant:
                    summary['excluded_discard_decision'] += 1
                continue
            gs = s.get('gameState') or {}
            dt = s.get('decisionTimeMs')
            if not isinstance(dt, int) or not (FROM <= dt < TO): continue
            if gs.get('gameVariant') != variant: continue
            # One natural decision per turn: a DEEP second look is journaled as
            # a second 'decision' record for the same turn.
            if s.get('type') != 'DECIDE_FAST':
                summary['excluded_deep_second_look'] += 1; continue
            if r.get('sourceRelease') != release:
                summary['excluded_release_other'] += 1; continue
            receipt = (body.get('decision') or {}).get('jointPolicy')
            board_count = gs.get('boardCount') or 1
            bomb = gs.get('bombPot') is True
            if board_count > 1: summary['multiboard_records'] += 1
            if bomb: summary['bomb_records'] += 1
            if gs.get('asset') == 'diamonds': summary['diamond_records'] += 1
            if receipt is None: summary['records_without_joint_receipt'] += 1
            dealt = gs.get('dealtSeatIds')
            dealt_players = len(dealt) if isinstance(dealt, list) else (
                receipt.get('dealtPlayers') if isinstance(receipt, dict) else None)
            summary['records'] += 1
            print(json.dumps({'eventId': r['eventId'], 'decisionTimeMs': dt, 'gameMode': gs.get('gameMode'),
                              'variant': variant, 'boardCount': board_count, 'bombPot': bomb,
                              'dealtPlayers': dealt_players, 'governorScale': body.get('governorScale'),
                              'receipt': receipt},
                             separators=(',', ':')))
print(json.dumps(dict(summary), sort_keys=True), file=sys.stderr)
