const fs = require('fs');

const file = 'src/pages/ClubHomePage.tsx';
let code = fs.readFileSync(file, 'utf8');

// 1. Fix setUnionIdForCreate so that if clubData.is_union is true, it sets it.
const searchStr = `
      // Check if this club is inside a union
      let unionId: string | null = null;
      let unionClubIds: string[] = [resolvedId];
      try {
        const { data: ucRow, error: ucErr } = await supabase
          .from('union_clubs')
          .select('union_id')
          .eq('club_id', resolvedId)
          .limit(1)
          .maybeSingle();
        if (!ucErr && ucRow) {
          if (getIsMounted && !getIsMounted()) return;
          setIsInUnion(true);
          unionId = ucRow.union_id;
          setUnionIdForCreate(ucRow.union_id);
`;

const replaceStr = `
      // Check if this club is inside a union
      let unionId: string | null = null;
      let unionClubIds: string[] = [resolvedId];
      try {
        if (clubData.is_union) {
          unionId = clubData.id;
          setUnionIdForCreate(clubData.id);
        }
        
        const { data: ucRow, error: ucErr } = await supabase
          .from('union_clubs')
          .select('union_id')
          .eq('club_id', resolvedId)
          .limit(1)
          .maybeSingle();
        if (!ucErr && ucRow) {
          if (getIsMounted && !getIsMounted()) return;
          setIsInUnion(true);
          unionId = ucRow.union_id;
          setUnionIdForCreate(ucRow.union_id);
`;

code = code.replace(searchStr, replaceStr);

fs.writeFileSync(file, code);
