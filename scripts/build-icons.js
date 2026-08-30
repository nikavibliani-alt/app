#!/usr/bin/env node
/** Build shared/icons.js from Tabler Icons (MIT) — run: npm run build:icons */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = join(ROOT, 'node_modules/@tabler/icons/icons/outline');

const ICON_NAMES = [
  'key', 'wifi', 'elevator', 'layout-grid', 'wash-machine', 'sparkles',
  'map-route', 'plane-arrival', 'star', 'file-text', 'message-circle',
  'home', 'map-pin', 'calendar', 'message-2', 'chevrons-up', 'dots', 'square-check',
  'bell', 'map-2', 'lock', 'alert-triangle', 'slash', 'currency-dollar', 'loader',
  'check', 'copy', 'pencil', 'clock', 'users', 'trash', 'x', 'menu',
  'chevron-up', 'chevron-down', 'chevron-left', 'chevron-right', 'logout', 'inbox',
  'navigation', 'info-circle', 'circle', 'plus', 'minus', 'grid-dots',
  'list', 'phone', 'bed', 'clipboard-check', 'grip-vertical', 'volume-off', 'home-heart',
];

const ALIASES = {
  'arrow-up-down': 'elevator',
  services: 'layout-grid',
  laundry: 'wash-machine',
  cleaning: 'sparkles',
  tour: 'map-route',
  landmark: 'map-route',
  transfer: 'plane-arrival',
  recs: 'star',
  rules: 'file-text',
  contact: 'message-circle',
  location: 'map-pin',
  info: 'info-circle',
  'dollar-sign': 'currency-dollar',
  'edit-2': 'pencil',
  'more-horizontal': 'dots',
  'check-square': 'square-check',
  'message-square': 'message-2',
  'log-out': 'logout',
  grid: 'grid-dots',
  custom: 'star',
  all: 'layout-grid',
};

function extractInner(svg) {
  const parts = [];
  const re = /<(path|circle|line|polyline|rect|polygon)([^>]*?)\/?>(?:<\/\1>)?/gi;
  let m;
  while ((m = re.exec(svg)) !== null) {
    const tag = m[1];
    const attrs = m[2];
    if (/d="M0 0h24v24H0z"/.test(attrs)) continue;
    if (/stroke="none"/.test(attrs) && tag === 'path') continue;
    parts.push(`<${tag}${attrs}></${tag}>`);
  }
  return parts.join('');
}

function loadIcon(name) {
  const file = join(ICON_DIR, `${name}.svg`);
  const svg = readFileSync(file, 'utf8');
  const inner = extractInner(svg);
  if (!inner) throw new Error(`No paths in Tabler icon: ${name}`);
  return inner;
}

const entries = {};
for (const name of ICON_NAMES) entries[name] = loadIcon(name);
for (const [alias, target] of Object.entries(ALIASES)) {
  entries[alias] = entries[target];
}

const lines = Object.entries(entries)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `  "${k}": ${JSON.stringify(v)},`)
  .join('\n');

const out = `/** Tabler Icons — MIT · https://tabler.io/icons · built by scripts/build-icons.js */
export const APP_ICONS={
${lines}
};

export function appIcon(name,size=24,stroke=1.75){
  const inner=APP_ICONS[name];
  if(!inner){
    const fb=APP_ICONS.circle||APP_ICONS['alert-triangle'];
    if(!fb)return \`<svg width="\${size}" height="\${size}" viewBox="0 0 24 24" aria-hidden="true"></svg>\`;
    return \`<svg width="\${size}" height="\${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="\${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\${fb}</svg>\`;
  }
  return \`<svg width="\${size}" height="\${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="\${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\${inner}</svg>\`;
}

/** @deprecated use appIcon — kept for gradual migration */
export const featherIcon=appIcon;
`;

writeFileSync(join(ROOT, 'shared/icons.js'), out);
console.log('Wrote shared/icons.js with', Object.keys(entries).length, 'icons (Tabler)');
