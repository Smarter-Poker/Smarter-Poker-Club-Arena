const fs = require('fs');
const file = 'src/components/admin/ClubMemberManagement.tsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /const loadMembers = async \(\) => \{/g,
  `const loadMembers = useCallback(async () => {`
);

content = content.replace(
  /if \(isMounted\.current\) setLoading\(false\);\n  };\n/g,
  `if (isMounted.current) setLoading(false);
  }, [clubId]);\n`
);

content = content.replace(
  /useEffect\(\(\) => \{\n    loadMembers\(\);\n  \}, \[clubId\]\);/g,
  `useEffect(() => {
    loadMembers();
  }, [loadMembers]);`
);

content = content.replace(
  /catch \(error\) \{/g,
  `catch (err) {`
);

fs.writeFileSync(file, content);
