const fs = require('fs');
let code = fs.readFileSync('src/services/HandPersistenceService.ts', 'utf8');

const targetStart = "          reportError(e, 'HandPersistence.onHandComplete.retryUpdateException');";
const targetEnd = "      // NOTE: rake_records insertion is server-side. The engine writes it via";

const startIdx = code.indexOf(targetStart) + targetStart.length;
const endIdx = code.indexOf(targetEnd);

const replaceWith = `
        }
      }
    }

    // NOTE: hand_players insertion was removed in Phase 11. ca_hand_facts is the new authoritative source.

`;

code = code.substring(0, startIdx) + replaceWith + code.substring(endIdx);
fs.writeFileSync('src/services/HandPersistenceService.ts', code);
