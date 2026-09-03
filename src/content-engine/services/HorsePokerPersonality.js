/**
 * HorsePokerPersonality — Personality archetypes, skill tiers, session profiles
 * STUB: Replace with full implementation
 *
 * Loaded by HorsePokerBrain.js via lazy import() — NOT manually wired.
 *
 * Play Style Archetypes: TAG, LAG, Calling Station, Maniac
 * Skill Tiers: Fish (35%), Recreational (55%), Grinder (75%), Reg (85%), Crusher (95%)
 */

function getHorsePokerProfile(_id) {
    return {
        playStyle: 'balanced',
        skillTier: 'grinder',
        vpip: 25, pfr: 18, af: 2.5,
        sessionProfile: { maxBuyins: 3, sessionLengthMinutes: 120 },
    };
}

function getPlayStyle(_id) { return 'balanced'; }
function getSkillTier(_id) { return 'grinder'; }
function getStats(_id) { return { vpip: 25, pfr: 18, af: 2.5, threeBet: 8 }; }
function getSessionProfile(_id) { return { maxBuyins: 3, sessionLengthMinutes: 120, preferredHours: [10, 22] }; }
function getStakesPreference(_id) { return 'low'; }
function shouldCashOut(_id, _stack, _startStack, _mins, _buyins, _tilt) { return false; }
function shouldSitAtTable(_id, _bigBlind, _playerCount) { return true; }
function getTiltFactor(_id) { return 0.3; }

export default {
    getHorsePokerProfile,
    getPlayStyle,
    getSkillTier,
    getStats,
    getSessionProfile,
    getStakesPreference,
    shouldCashOut,
    shouldSitAtTable,
    getTiltFactor,
};
