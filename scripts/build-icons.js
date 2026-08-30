#!/usr/bin/env node
/** Build shared/feather-icons.js from Lucide (MIT) — run: node scripts/build-icons.js */
import { writeFileSync } from 'fs';
import { icons } from 'lucide';

const ICON_NAMES = [
  'calendar','message-square','chevrons-up','more-horizontal','check-square','home','key','wifi',
  'map-pin','bell','map','file-text','star','lock','alert-triangle','slash','dollar-sign','loader',
  'check','copy','edit-2','clock','users','trash-2','x','menu','chevron-up','chevron-down',
  'chevron-left','chevron-right','log-out','inbox','layers','navigation','message-circle','info',
  'circle','plus','minus','grid','package','truck','book-open','list','phone','sun',
  // Better semantic icons (guest settings + nav)
  'arrow-up-down','sparkles','washing-machine','compass','plane','bed','clipboard-check',
  'layout-grid','ellipsis','pencil','grip-vertical',
];

const ALIASES = { 'edit-2': 'pencil' };

function kebabToPascal(name) {
  return name.split('-').map(p => p[0].toUpperCase() + p.slice(1)).join('');
}

function nodeToSvg(nodes) {
  return nodes.map(([tag, attrs]) => {
    const a = Object.entries(attrs).map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`).join(' ');
    return `<${tag}${a ? ' ' + a : ''}></${tag}>`;
  }).join('');
}

function resolveIcon(name) {
  const resolved = ALIASES[name] || name;
  const nodes = icons[kebabToPascal(resolved)];
  if (!nodes) throw new Error(`Missing Lucide icon: ${name} (${resolved})`);
  return nodeToSvg(nodes);
}

const entries = {};
for (const name of ICON_NAMES) entries[name] = resolveIcon(name);
// feather aliases → same lucide art
if (entries.ellipsis) entries['more-horizontal'] = entries.ellipsis;
if (entries.pencil) entries['edit-2'] = entries.pencil;

const lines = Object.entries(entries)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `  "${k}": ${JSON.stringify(v)},`)
  .join('\n');

const out = `/** Lucide Icons — ISC · https://lucide.dev · built by scripts/build-icons.js */
export const FEATHER_ICONS={
${lines}
};

export function featherIcon(name,size=24,stroke=2){
  const inner=FEATHER_ICONS[name];
  if(!inner){
    const fb=FEATHER_ICONS.circle||FEATHER_ICONS['alert-triangle'];
    if(!fb)return \`<svg width="\${size}" height="\${size}" viewBox="0 0 24 24" aria-hidden="true"></svg>\`;
    return \`<svg width="\${size}" height="\${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="\${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\${fb}</svg>\`;
  }
  return \`<svg width="\${size}" height="\${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="\${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\${inner}</svg>\`;
}
`;

writeFileSync(new URL('../shared/feather-icons.js', import.meta.url), out);
console.log('Wrote shared/feather-icons.js with', Object.keys(entries).length, 'icons');
