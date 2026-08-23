const fs = require('fs');
const file = 'src/services/MembershipService.ts';
let content = fs.readFileSync(file, 'utf8');

const replacement = `      let online = 0;
      try {
        const { data: tables } = await supabase.rpc('get_active_tables_for_club', { p_club_id: resolvedId });
        if (tables) {
          const seated = new Set<string>();
          for (const t of tables) {
            if (t.seats) {
              Object.values(t.seats).forEach((s: any) => {
                if (s?.userId) seated.add(s.userId);
              });
            }
          }
          online = seated.size;
        }
      } catch (e) {
        /* non-critical */
      }`;

content = content.replace(
  /\s*\/\/ Estimate online count[\s\S]*?const online = Math\.floor\(\(active \|\| 0\) \* 0\.15\);/,
  `\n${replacement}`
);

fs.writeFileSync(file, content);
