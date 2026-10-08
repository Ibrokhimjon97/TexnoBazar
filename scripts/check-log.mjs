import { readFileSync } from 'node:fs';

const log = readFileSync('C:/Users/user/.gemini/antigravity-ide/brain/c3419703-48b0-46a6-9c83-889f4180dba8/.system_generated/tasks/task-339.log', 'utf8');
const lines = log.split('\n');
lines.forEach((l, i) => {
  if (l.toLowerCase().includes('domassi') || l.toLowerCase().includes('kolyaska') || l.toLowerCase().includes('chopper') || l.toLowerCase().includes('10854')) {
    console.log(`Line ${i}: ${l}`);
  }
});
