const fs = require('fs');
let code = fs.readFileSync('src/services/HandHistoryService.ts', 'utf8');

const targetStart = "  async saveHandToSupabase(";
const targetEnd = "  private getPositionOrder(";

const startIdx = code.indexOf(targetStart);
const endIdx = code.indexOf(targetEnd);

if (startIdx > -1 && endIdx > startIdx) {
  // back up slightly to remove the doc comment if any
  const docCommentStart = code.lastIndexOf("  /**", startIdx);
  const actualStartIdx = docCommentStart > -1 && docCommentStart > startIdx - 100 ? docCommentStart : startIdx;
  code = code.substring(0, actualStartIdx) + code.substring(endIdx);
  fs.writeFileSync('src/services/HandHistoryService.ts', code);
  console.log("Replaced successfully");
} else {
  console.log("Could not find targets in HHS");
}
