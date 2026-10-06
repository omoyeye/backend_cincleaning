// Builds the API and packs only what the DirectAdmin server needs into deploy/cin-backend-<stamp>.tar.gz.
// Upload it to the Node.js app root, extract it there, run NPM install if dependencies changed, then restart.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const check = (r, label) => {
  if (r.status !== 0) {
    console.error(`\n${label} failed.`);
    process.exit(r.status ?? 1);
  }
};

// Start from a clean build so stale compiled files never ship.
rmSync('dist', { recursive: true, force: true });
check(spawnSync('npm run build', { stdio: 'inherit', shell: true }), 'npm run build');

if (!existsSync('dist/index.js')) {
  console.error('Build output missing: dist/index.js');
  process.exit(1);
}

const now = new Date();
const p = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
mkdirSync('deploy', { recursive: true });
const archive = `deploy/cin-backend-${stamp}.tar.gz`;

const files = ['dist', 'drizzle', 'package.json', 'package-lock.json', '.npmrc'].filter((f) => existsSync(f));
check(spawnSync('tar', ['-czf', archive, ...files], { stdio: 'inherit' }), 'tar');

console.log(`\nDeploy package ready: backend/${archive}`);
console.log('Contains:', files.join(', '));
console.log('Startup file on the server: dist/index.js');
