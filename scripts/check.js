import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const directory of ['server', 'public', 'scripts', 'test']) {
  for (const file of readdirSync(new URL(`../${directory}/`, import.meta.url)).filter(name => name.endsWith('.js'))) {
    const path = new URL(`../${directory}/${file}`, import.meta.url);
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(path)], { encoding: 'utf8' });
    if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
  }
}
console.log('All JavaScript files passed syntax checks.');
