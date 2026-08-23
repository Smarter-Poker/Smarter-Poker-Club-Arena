const fs = require('fs');
let code = fs.readFileSync('src/pages/ClubHomePage.tsx', 'utf8');

// Fix tournament fetching statuses for standalone clubs
code = code.replace(
  /\.in\('status',\s*\['REGISTERING',\s*'RUNNING'\]\)/g,
  ".in('status', ['REGISTERING', 'RUNNING', 'LATE_REG', 'STARTING_SOON'])"
);

fs.writeFileSync('src/pages/ClubHomePage.tsx', code);
