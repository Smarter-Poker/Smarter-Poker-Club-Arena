const fs = require('fs');
let code = fs.readFileSync('src/components/lobby/LobbyTable.css', 'utf8');

code = code.replace(
  "min-width: 640px;",
  "min-width: 100%;\n  white-space: nowrap;"
);

// We need to add a media query to shrink everything on mobile.
code += `
@media (max-width: 768px) {
  .lobby-table {
    font-size: 0.65rem;
  }
  .lobby-table th, .lobby-table td {
    padding: 6px 4px;
  }
  .lt-countdown {
    font-size: 0.6rem !important;
  }
  .lt-badge {
    font-size: 0.55rem;
    padding: 0.1rem 0.25rem;
  }
}
`;

fs.writeFileSync('src/components/lobby/LobbyTable.css', code);
