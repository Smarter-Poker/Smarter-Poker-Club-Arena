const fs = require('fs');
const file = 'src/components/admin/ClubMemberManagement.tsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /import \{ useState, useEffect, useRef \} from 'react';/,
  `import { useState, useEffect, useRef, useCallback } from 'react';`
);

content = content.replace(
  /}, \[clubId\]\);\n/g,
  `}, [clubId, isMounted, toast]);\n`
);

content = content.replace(
  /catch \(err\) \{/g,
  `catch (err) {
      console.error(err);`
);

fs.writeFileSync(file, content);
