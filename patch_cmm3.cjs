const fs = require('fs');
const file = 'src/components/admin/ClubMemberManagement.tsx';
let content = fs.readFileSync(file, 'utf8');

// Add useCallback to the React import
content = content.replace(
  /import React, \{ useState, useEffect, useRef \} from 'react';/,
  `import React, { useState, useEffect, useRef, useCallback } from 'react';`
);

// Move the useEffect that calls loadMembers AFTER loadMembers definition
content = content.replace(
  /\s*useEffect\(\(\) => \{\n\s*loadMembers\(\);\n\s*\}, \[loadMembers\]\);\n/,
  ``
);

content = content.replace(
  /if \(isMounted\.current\) setLoading\(false\);\n\s*\}, \[clubId, isMounted, toast\]\);\n/,
  `if (isMounted.current) setLoading(false);
  }, [clubId, isMounted, toast]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);\n`
);

fs.writeFileSync(file, content);
