const fs = require('fs');
let code = fs.readFileSync('src/pages/LeaderboardPage.tsx', 'utf8');

code = code.replace(
  `          ? await LeaderboardService.getGlobalUserRank(user.id, metric, period)
          : await LeaderboardService.getUserRank(user.id, selectedClubId as string, metric, period);`,
  `          ? await LeaderboardService.getGlobalUserRank(user.id, metric, period, periodOffset)
          : await LeaderboardService.getUserRank(user.id, selectedClubId as string, metric, period, periodOffset);`
);

fs.writeFileSync('src/pages/LeaderboardPage.tsx', code);
