const fs = require('fs');
let code = fs.readFileSync('src/components/lobby/AdvancedFilters.tsx', 'utf8');

// Replace sections
code = code.replace(/<section className="afx-section">/g, '<details className="afx-section">');
code = code.replace(/<\/section>/g, '</details>');

// Wrap h3 inside summary. Note that some h3s are multi-line because of variables.
// Use a regex that catches everything between <h3> and </h3>
code = code.replace(/<h3>([\s\S]*?)<\/h3>/g, '<summary><h3>$1</h3></summary>');

fs.writeFileSync('src/components/lobby/AdvancedFilters.tsx', code);
