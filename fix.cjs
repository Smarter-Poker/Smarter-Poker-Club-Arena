const fs = require('fs');
let code = fs.readFileSync('src/pages/InvitePage.tsx', 'utf8');

// 1. Remove MembershipService
code = code.replace(/import { MembershipService } from '\.\.\/services\/MembershipService';\n/g, '');

// 2. Add useCallback
code = code.replace(
  "import { useState, useEffect, useRef } from 'react';",
  "import React, { useState, useEffect, useRef, useCallback } from 'react';"
);

// 3. Move toast up and useCallback
code = code.replace(
  /  const { user } = useAuthUser\(\);\n  useVisibilityRefresh\(\(\) => loadClubInfo\(\)\);\n/,
  "  const { user } = useAuthUser();\n  const toast = useToast();\n"
);

code = code.replace(
  /  const toast = useToast\(\);\n/,
  ""
);

// find loadClubInfo definition and useVisibilityRefresh
const loadStart = code.indexOf("  const loadClubInfo = async (getIsMounted?: () => boolean) => {");
const loadEnd = code.indexOf("  };", loadStart) + 4;
let loadFunc = code.substring(loadStart, loadEnd);

// modify loadFunc
loadFunc = loadFunc.replace(
  "const loadClubInfo = async (getIsMounted?: () => boolean) => {",
  "const loadClubInfo = useCallback(async (getIsMounted?: () => boolean) => {"
);
loadFunc = loadFunc.replace(
  "  };",
  "  }, [clubId, inviteCode, user?.id, toast]);"
);

// remove loadFunc from original spot
code = code.substring(0, loadStart) + code.substring(loadEnd);

// find where to insert it (right before useEffect)
const insertIndex = code.indexOf("  useEffect(() => {\n    let isMounted = true;");
code = code.substring(0, insertIndex) + loadFunc + "\n\n  useVisibilityRefresh(() => loadClubInfo());\n\n" + code.substring(insertIndex);

// fix deps of the first useEffect
code = code.replace(
  "  }, [clubId, inviteCode]);",
  "  }, [loadClubInfo]);"
);

// fix deps of the second useEffect (qr code)
code = code.replace(
  "  }, [club?.id]);\n\n  const handleCopyLink",
  "  }, [club?.id, club?.slug, refCode, user?.id]);\n\n  const handleCopyLink"
);

fs.writeFileSync('src/pages/InvitePage.tsx', code);
