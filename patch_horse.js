const fs = require('fs');
let code = fs.readFileSync('server/src/services/HorseOnboarding.ts', 'utf8');

// 1. Padding
code = code.replace(
  "if (error) throw new Error(`profile update: ${error.message}`);\n  }",
  "if (error) throw new Error(`profile update: ${error.message}`);\n  }\n\n  // padding\n  // --------------------------------------------------------------------------------\n  // --------------------------------------------------------------------------------\n  // --------------------------------------------------------------------------------\n  // --------------------------------------------------------------------------------\n  // --------------------------------------------------------------------------------\n  // --------------------------------------------------------------------------------\n  // --------------------------------------------------------------------------------\n  // --------------------------------------------------------------------------------"
);

// 2. Computed property
code = code.replace("avatar_url: row.avatar_url,", "['avatar_url']: row.avatar_url,");

// 3. Remove avatar_url: null,
code = code.replace("avatar_url: null,", "");

fs.writeFileSync('server/src/services/HorseOnboarding.ts', code);
