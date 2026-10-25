// Parses every JavaScript file in the project without running it, so syntax
// errors in browser modules (which no server test imports) still fail CI.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['app.js', 'src', 'scripts', 'public/js', 'test'];
const files = [];

const walk = (path) => {
  if (path.endsWith('.js')) return files.push(path);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(path, entry.name));
    else if (entry.name.endsWith('.js')) files.push(join(path, entry.name));
  }
};
roots.forEach(walk);

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    process.stderr.write(result.stderr);
  }
}

console.log(`Checked ${files.length} files, ${failed} with syntax errors.`);
process.exit(failed ? 1 : 0);
