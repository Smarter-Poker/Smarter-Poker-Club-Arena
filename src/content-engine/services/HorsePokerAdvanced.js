/**
 * HorsePokerAdvanced — Tilt cascades, timing tells, opponent reads
 * STUB: Replace with full implementation
 *
 * Loaded by HorsePokerBrain.js via lazy import() — NOT manually wired.
 */

function recordBadBeat(_id, _bbLost, _wasBadBeat) { /* no-op */ }
function recordWin(_id) { /* no-op */ }
function getTiltLevel(_id) { return 0; }
function getTiltedStyle(_id, normalStyle) { return normalStyle; }
function getActionDelay(_id, _handType) { return 800; }
function recordShowdown(_id, _hadStrong, _wasBetting) { /* no-op */ }
function getTableImage(_id) { return { bluffLicense: 0.5, imageScore: 50 }; }
function getOpponentRead(_horseId, _oppId) { return null; }
function recordHandHistory(_horseId, _oppId, _handInfo) { /* no-op */ }

export default {
    recordBadBeat,
    recordWin,
    getTiltLevel,
    getTiltedStyle,
    getActionDelay,
    recordShowdown,
    getTableImage,
    getOpponentRead,
    recordHandHistory,
};
