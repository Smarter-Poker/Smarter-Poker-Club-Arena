const fs = require('fs');
let code = fs.readFileSync('src/services/HandPersistenceService.ts', 'utf8');

const targetStr = `        const { error: hpError } = await supabase.from('hand_players').insert(handPlayerRows);

        if (hpError) {
          reportError(hpError, 'HandPersistence.onHandComplete.insertPlayers', { handNumber });
        }`;

code = code.replace(targetStr, `        // hand_players insertion removed in Phase 11`);
fs.writeFileSync('src/services/HandPersistenceService.ts', code);
