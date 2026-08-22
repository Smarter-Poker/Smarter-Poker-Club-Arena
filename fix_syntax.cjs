const fs = require('fs');
const file = 'src/pages/ClubHomePage.tsx';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  "                </div>\n              </div>\n          </div>",
  "                </div>\n              </div>\n            </div>\n          </div>"
);

fs.writeFileSync(file, code);
