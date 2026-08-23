const fs = require('fs');

function fixYellows() {
  const file1 = 'src/pages/ClubHomePage.css';
  let css1 = fs.readFileSync(file1, 'utf8');
  
  // Underline
  css1 = css1.replace(/linear-gradient\(90deg, #ffb800, #ff8c00\)/g, 'linear-gradient(90deg, #3b82f6, #2563eb)');
  
  fs.writeFileSync(file1, css1);
  
  const file2 = 'src/components/lobby/AdvancedFilters.css';
  let css2 = fs.readFileSync(file2, 'utf8');
  
  css2 = css2.replace(/color: #ffb800;/g, 'color: #3b82f6;');
  css2 = css2.replace(/linear-gradient\(90deg, #ffb800, #ff9d00\)/g, 'linear-gradient(90deg, #3b82f6, #2563eb)');
  css2 = css2.replace(/radial-gradient\(circle at 35% 30%, #ffd76b, #ffb800 60%, #b87f00 100%\)/g, 'radial-gradient(circle at 35% 30%, #93c5fd, #3b82f6 60%, #1d4ed8 100%)');
  css2 = css2.replace(/background: #ffb800;/g, 'background: #3b82f6;');
  css2 = css2.replace(/linear-gradient\(135deg, #ffd76b, #ffb800\)/g, 'linear-gradient(135deg, #9ca3af, #4b5563)'); // reset button to silver/gray
  
  fs.writeFileSync(file2, css2);
}

fixYellows();
