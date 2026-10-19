'use strict';

// Shared knowledge base (KB) for the WhatsApp bot and, later, a Booking.com
// inbox answerer. See KNOWLEDGE_BASE.md for the structure.
//
// - seed.js: the facts as they were in the bot's SYSTEM_PROMPT (word for word)
//   plus structured fields (prices as numbers, unit types, properties).
// - Firestore (optional, read-only here): kb_properties/{id}, kb_units/{roomCode},
//   kb_unit_types/{id}, kb_policies/{id}, kb_media/{id}. A doc overrides the
//   seed entry with the same id (deep merge). No docs -> the seed, unchanged.
// - promptTemplate.js: the bot's RULES with {{path}} placeholders for facts.
//
// This module only reads. It never reads door codes or lock ids from anywhere.
// WiFi is not in the KB: it comes from the check-in page data (loadUnitWifi).

const SEED = require('./seed');
const { SYSTEM_PROMPT_TEMPLATE } = require('./promptTemplate');

const COLLECTIONS = {
  properties: 'kb_properties',
  units: 'kb_units',
  unitTypes: 'kb_unit_types',
  policies: 'kb_policies',
  media: 'kb_media',
};
// Never copied from Firestore into the KB, whatever a doc contains.
const FORBIDDEN_FIELDS = new Set(['doorCode', 'tuyaDeviceId', 'lockCode', 'smartLockCode', 'pin', 'password_admin']);
const CACHE_MS = 5 * 60 * 1000;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function deepMerge(base, over) {
  const out = isObj(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over || {})) {
    if (FORBIDDEN_FIELDS.has(k)) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : clone(v);
  }
  return out;
}

/** Value at a dotted path ("policies.parking.reply.en"), or undefined. */
function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** The bot's system prompt with every {{path}} filled from `kb`. Throws on a missing or non-text fact. */
function renderSystemPrompt(kb = SEED, template = SYSTEM_PROMPT_TEMPLATE) {
  return template.replace(/\{\{([\w.]+)\}\}/g, (_, path) => {
    const v = getPath(kb, path);
    if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`knowledge base: missing fact "${path}"`);
    return String(v);
  });
}

/** Every placeholder path the template uses (for checks and docs). */
function templatePaths(template = SYSTEM_PROMPT_TEMPLATE) {
  return [...new Set([...template.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1]))];
}

/** The property id for a room code (by roomPrefixes), or null. */
function propertyIdForRoom(kb, roomCode) {
  const code = String(roomCode || '').trim().toLowerCase();
  if (!code) return null;
  if (kb.units?.[code]?.property) return kb.units[code].property;
  for (const [id, p] of Object.entries(kb.properties || {})) {
    if ((p.roomPrefixes || []).some((pre) => code.startsWith(pre))) return id;
  }
  return null;
}

/**
 * Guest-context lines with this unit's own facts (type, kitchen, guests) and
 * its WiFi, only for properties the bot answers. `wifi` ({ name, password })
 * comes from the check-in page data (loadUnitWifi): it is the only WiFi
 * source, since several units share one network. [] if the unit is unknown.
 */
function unitFactLines(kb, roomCode, wifi = null) {
  const code = String(roomCode || '').trim().toLowerCase();
  const unit = kb.units?.[code];
  const prop = kb.properties?.[unit?.property];
  if (!unit || !prop?.botAnswers) return [];
  const type = kb.unitTypes?.[unit.type];
  const lines = [];
  if (type) {
    const guests = type.maxGuests ? `, up to ${type.maxGuests} guests${type.maxBabies ? ` plus ${type.maxBabies} baby in the baby bed` : ''}` : '';
    lines.push(`This guest's unit: ${code} is a ${type.name}${type.kitchen === true ? ' (has a kitchen)' : type.kitchen === false ? ' (no kitchen)' : ''}${guests}.`);
  }
  if (wifi?.name && wifi?.password) lines.push(`This guest's WiFi (from their check-in page, exactly as written): network "${wifi.name}", password "${wifi.password}".`);
  return lines;
}

/**
 * The unit's WiFi from the check-in page data (checkin_apartments wifiName /
 * wifiPass), read-only and selecting only those two fields (never door codes).
 * { name, password } or null (unknown unit, nothing saved, or a failed read).
 */
async function loadUnitWifi(db, roomCode, { log = console } = {}) {
  const code = String(roomCode || '').trim().toLowerCase();
  if (!code) return null;
  try {
    const ref = db.collection('checkin_apartments').doc(code);
    const snap = await db.collection('checkin_apartments').where('__name__', '==', ref).select('wifiName', 'wifiPass').get();
    if (snap.empty) return null;
    const name = String(snap.docs[0].get('wifiName') || '').trim();
    const password = String(snap.docs[0].get('wifiPass') || '').trim();
    return name && password ? { name, password } : null;
  } catch (err) {
    log.warn(`knowledge base: WiFi for ${code} unavailable (${err?.message || err})`);
    return null;
  }
}

/** Reads the kb_* collections (read-only) and merges them over the seed. */
async function readKnowledgeBase(db, seed = SEED) {
  let kb = clone(seed);
  for (const [section, collection] of Object.entries(COLLECTIONS)) {
    const snap = await db.collection(collection).get();
    if (snap.empty) continue;
    const over = {};
    snap.docs.forEach((d) => { over[d.id] = d.data(); });
    kb = { ...kb, [section]: deepMerge(kb[section], over) };
  }
  return kb;
}

let cache = { at: 0, kb: null };
/**
 * The knowledge base for this request: Firestore over the seed, cached for 5
 * minutes per instance. Any error -> the seed (logged), so the bot never stops.
 */
async function loadKnowledgeBase(db, { nowMs = Date.now(), log = console } = {}) {
  if (cache.kb && nowMs - cache.at < CACHE_MS) return cache.kb;
  let kb = SEED;
  try {
    kb = await readKnowledgeBase(db);
    renderSystemPrompt(kb); // a Firestore edit that removes a fact must not break replies
  } catch (err) {
    log.warn(`knowledge base: using the built-in seed (${err?.message || err})`);
    kb = SEED;
  }
  cache = { at: nowMs, kb };
  return kb;
}

function resetKnowledgeBaseCache() { cache = { at: 0, kb: null }; }

module.exports = {
  SEED,
  COLLECTIONS,
  getPath,
  deepMerge,
  renderSystemPrompt,
  templatePaths,
  propertyIdForRoom,
  unitFactLines,
  loadUnitWifi,
  readKnowledgeBase,
  loadKnowledgeBase,
  resetKnowledgeBaseCache,
};
