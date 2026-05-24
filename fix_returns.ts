import * as fs from 'fs';

let content = fs.readFileSync('src/bot.ts', 'utf-8');

const startIndex = content.indexOf('const executeEntryAndGetBlocker = async (): Promise<string> => {');
const endIndex = content.indexOf('return botState.blocker || "EXECUTION_ROUTER_BLOCKED";\n      }; // end of executeEntryAndGetBlocker');

if (startIndex !== -1 && endIndex !== -1) {
  const before = content.substring(0, startIndex);
  let middle = content.substring(startIndex, endIndex);
  const after = content.substring(endIndex);
  
  middle = middle.replace(/^\s*return;?\s*$/gm, '          return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";');
  
  content = before + middle + after;
}

fs.writeFileSync('src/bot.ts', content);
console.log("Done fixing returns!");
