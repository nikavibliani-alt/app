'use strict';

// Runs before every `firebase deploy --only functions:whatsapp` (firebase.json
// predeploy). Writes build-info.json next to index.js with the git commit being
// deployed, so each bot_decisions document can say which code made it
// (botDecisions.js). build-info.json is git-ignored. Never fails the deploy.

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..');
const run = (cmd) => {
  try {
    return execSync(cmd, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
};

const commit = run('git rev-parse --short HEAD');
// Uncommitted changes inside whatsapp-functions/ mean the commit alone does not describe the code.
// (Untracked files are ignored: tool folders like .claude/ live there.)
const dirty = run('git status --porcelain --untracked-files=no -- .').split('\n').some((l) => l && !l.includes('build-info.json'));
const info = { commit, dirty, builtAt: new Date().toISOString() };

fs.writeFileSync(path.join(dir, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
console.log(`build-info: ${commit || 'unknown commit'}${dirty ? ' (with uncommitted changes)' : ''}`);
