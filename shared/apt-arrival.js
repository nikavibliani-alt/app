/* Apartment types, arrival steps and access methods, shared by the admin page, the guest page and house rules.
 *
 * Data (checkin_admin/config.aptTypes[GROUP], readable by everyone, so NEVER any code in it):
 *   { access:{ method:'smartlock'|'code'|'lockbox'|'handover', entranceCard, lockboxWhere, lockboxPhoto,
 *              handoverWho, handoverPhone, handoverWhere, returnNote },
 *     steps:[{ id, title, text, photo, perUnitPhoto }], updatedAt }
 * The type's entrance / building code is NOT here: it is in checkin_type_codes/{GROUP}.entranceCode (a code, so never in the config).
 * Unit (checkin_apartments/{unit}) keeps its own fields and adds: accessMethod ('' = same as type), lockboxCode, entranceCode (own code, beats the type's),
 *   stepPhotos:{[stepId]:url}. The unit's own steps stay photos[] + photoCaptions[].
 * With nothing saved for a type, resolveArrival() gives exactly what the guest page shows today.
 */

export const APT_GROUPS = [
  { id: 'ROOMS', label: 'Shartava rooms', icon: 'bed' },
  { id: 'MAXELA', label: 'Shartava apartments', icon: 'home' },
  { id: 'BIG_APT', label: 'Big apartment', icon: 'users' },
  { id: 'FREEDOM', label: 'Freedom Square', icon: 'map-pin' },
  { id: 'ORBELIANI', label: 'Orbeliani', icon: 'navigation' },
  { id: 'VGL', label: 'VGL Group', icon: 'layers' },
  { id: 'XCV', label: 'Modern Avlabari', icon: 'compass' },
];

const KNOWN_ROOM_GROUP = {
  '0-1': 'ROOMS', '0-2': 'ROOMS', '0-3': 'ROOMS', '0-4': 'ROOMS', '0-5': 'ROOMS',
  '6-1': 'MAXELA', '6-2': 'MAXELA', '6-4': 'MAXELA',
  '6-3': 'BIG_APT',
  '7-1': 'MAXELA', '7-2': 'MAXELA', '7-3': 'MAXELA', '7-4': 'MAXELA',
  'tab-1': 'FREEDOM', 'tab-2': 'FREEDOM', 'tab-3': 'FREEDOM',
};

/* Unit code -> listing group. Known rooms keep their fixed group; new rooms use their id prefix or their site. */
export function roomGroup(code, site) {
  const c = String(code || '');
  if (/^orb-/i.test(c)) return 'ORBELIANI';
  if (KNOWN_ROOM_GROUP[c]) return KNOWN_ROOM_GROUP[c];
  if (/^xcv-/i.test(c) || site === 'xcv') return 'XCV';
  if (/^vgl-/i.test(c) || site === 'vgl') return 'VGL';
  return 'ROOMS';
}
export function groupLabel(id) {
  const g = APT_GROUPS.find((x) => x.id === id);
  return g ? g.label : id;
}

export const ACCESS_METHODS = ['smartlock', 'code', 'lockbox', 'handover'];
export const ACCESS_LABELS = {
  smartlock: 'Smart lock',
  code: 'Door code',
  lockbox: 'Lock box with key',
  handover: 'Key handed over',
};
export const ACCESS_DESCRIPTIONS = {
  smartlock: 'New code every booking, made automatically',
  code: 'Same code every stay',
  lockbox: 'Box code + where it is',
  handover: 'Someone meets the guest',
};
export const ACCESS_GUEST_SEES = {
  smartlock: 'Guest sees: their own door code, once the room is ready',
  code: 'Guest sees: the door code, once the room is ready',
  lockbox: 'Guest sees: the lock box code, where the box is, and a photo',
  handover: 'Guest sees: who meets them, where, and a WhatsApp button',
};
export const DEFAULT_RETURN_NOTES = {
  smartlock: '',
  code: '',
  lockbox: 'Put the key back in the lock box and close it',
  handover: 'Leave the key on the table',
};

const str = (v) => (typeof v === 'string' ? v : '');
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

function normSteps(list) {
  return (Array.isArray(list) ? list : []).filter((s) => s && typeof s === 'object').map((s, i) => ({
    id: str(s.id) || ('s' + (i + 1)),
    title: str(s.title),
    text: str(s.text),
    photo: str(s.photo),
    perUnitPhoto: s.perUnitPhoto === true,
  }));
}

/* clean copy of a saved type: unknown or missing parts are dropped, so the rest of the code can trust the shape */
export function normalizeTypeCfg(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw.access && typeof raw.access === 'object' ? raw.access : {};
  const method = ACCESS_METHODS.includes(a.method) ? a.method : '';
  const steps = normSteps(raw.steps);
  const checkoutSteps = normSteps(raw.checkoutSteps);
  const access = {
    method,
    entranceCard: a.entranceCard === true,
    lockboxWhere: str(a.lockboxWhere),
    lockboxPhoto: str(a.lockboxPhoto),
    handoverWho: str(a.handoverWho),
    handoverPhone: digits(a.handoverPhone),
    handoverWhere: str(a.handoverWhere),
    returnNote: str(a.returnNote),
    buildingLabel: str(a.buildingLabel).trim().slice(0, 60),   // title of the building code card on the guest page ('' = the default words)
  };
  const empty = !steps.length && !checkoutSteps.length && !method && !access.entranceCard && !access.lockboxWhere && !access.lockboxPhoto
    && !access.handoverWho && !access.handoverPhone && !access.handoverWhere && !access.returnNote && !access.buildingLabel;
  if (empty) return null;   // nothing filled in: the guest page keeps looking exactly like today
  return { access, steps, checkoutSteps, updatedAt: raw.updatedAt || null };
}

/* The access method for a unit: its own choice, else the type's, else the smart lock box that exists today. */
export function resolveAccessMethod(typeCfg, unit) {
  const own = unit && ACCESS_METHODS.includes(unit.accessMethod) ? unit.accessMethod : '';
  const t = normalizeTypeCfg(typeCfg);
  const fromType = t && t.access.method;
  return { method: own || fromType || 'smartlock', source: own ? 'unit' : (fromType ? 'type' : 'default') };
}

/*
 * -> { access, steps }
 * access: the method plus the type's details (where the lock box is, who meets the guest, return note, entrance card).
 * steps: the type's steps first (a per-unit photo step uses the unit's own photo), then the unit's own photo steps.
 * No codes are ever read here: steps keep their {placeholders}; fill them with fillPlaceholders().
 */
export function resolveArrival(typeCfg, unit, ctx = {}) {
  const t = normalizeTypeCfg(typeCfg);
  const u = unit || {};
  const m = resolveAccessMethod(t, u);
  const a = (t && t.access) || {};
  const access = {
    method: m.method,
    source: m.source,
    entranceCard: a.entranceCard === true,
    lockboxWhere: a.lockboxWhere || '',
    lockboxPhoto: a.lockboxPhoto || '',
    handoverWho: a.handoverWho || '',
    handoverPhone: a.handoverPhone || '',
    handoverWhere: a.handoverWhere || '',
    returnNote: a.returnNote || '',
    buildingLabel: a.buildingLabel || '',
    returnNoteIsDefault: !a.returnNote && !!DEFAULT_RETURN_NOTES[m.method],
  };
  const stepPhotos = u.stepPhotos && typeof u.stepPhotos === 'object' ? u.stepPhotos : {};
  const steps = [];
  for (const s of (t ? t.steps : [])) {
    const photo = s.perUnitPhoto ? str(stepPhotos[s.id]) : s.photo;
    steps.push({ id: s.id, title: s.title, text: s.text, photo, shared: true, perUnitPhoto: s.perUnitPhoto, missingPhoto: s.perUnitPhoto && !photo });
  }
  const photos = Array.isArray(u.photos) ? u.photos : [];
  const caps = Array.isArray(u.photoCaptions) ? u.photoCaptions : [];
  photos.forEach((p, i) => {
    steps.push({ id: 'unit-' + i, title: '', text: str(caps[i]), photo: str(p), shared: false, perUnitPhoto: false, missingPhoto: false, unitIndex: i });
  });
  return { access, steps };
}

/*
 * -> check-out steps: the type's steps first (a per-unit photo step uses the unit's own photo), then the unit's own extra steps
 * (checkoutPhotos[] + checkoutPhotoCaptions[]; an empty one is skipped). Same shape as the arrival steps. [] = nothing to show.
 */
export function resolveCheckout(typeCfg, unit) {
  const t = normalizeTypeCfg(typeCfg);
  const u = unit || {};
  const stepPhotos = u.stepPhotos && typeof u.stepPhotos === 'object' ? u.stepPhotos : {};
  const steps = [];
  for (const s of (t ? t.checkoutSteps : [])) {
    const photo = s.perUnitPhoto ? str(stepPhotos[s.id]) : s.photo;
    steps.push({ id: s.id, title: s.title, text: s.text, photo, shared: true, perUnitPhoto: s.perUnitPhoto, missingPhoto: s.perUnitPhoto && !photo });
  }
  const photos = Array.isArray(u.checkoutPhotos) ? u.checkoutPhotos : [];
  const caps = Array.isArray(u.checkoutPhotoCaptions) ? u.checkoutPhotoCaptions : [];
  for (let i = 0; i < Math.max(photos.length, caps.length); i++) {
    const photo = str(photos[i]);
    const text = str(caps[i]);
    if (!photo && !text.trim()) continue;
    steps.push({ id: 'co-unit-' + i, title: '', text, photo, shared: false, perUnitPhoto: false, missingPhoto: false, unitIndex: i });
  }
  return steps;
}

/*
 * Fills {room}, {door code}, {lock box code}, {entrance code}, {elevator code} (and the old #elevatorcode).
 * ctx: { room, doorCode, lockboxCode, entranceCode, elevatorCode, lockedText }
 * The four codes are filled ONLY when `unlocked` is true; before that they show lockedText
 * (the same "shown when your room is ready" text the code box uses). {room} is not secret.
 */
export function fillPlaceholders(text, ctx = {}, unlocked = false) {
  let out = String(text == null ? '' : text);
  const locked = ctx.lockedText || '';
  const code = (v) => (unlocked ? (v ? String(v) : (ctx.missingText || 'contact host')) : locked);
  out = out.replace(/\{\s*room\s*\}/gi, ctx.room || '');
  out = out.replace(/\{\s*door[ _-]?code\s*\}/gi, () => code(ctx.doorCode));
  out = out.replace(/\{\s*lock[ _-]?box[ _-]?code\s*\}/gi, () => code(ctx.lockboxCode));
  out = out.replace(/\{\s*(?:entrance|building)[ _-]?code\s*\}/gi, () => code(ctx.entranceCode));
  out = out.replace(/\{\s*elevator[ _-]?code\s*\}/gi, () => code(ctx.elevatorCode));
  out = out.replace(/#elevatorcode/g, () => (ctx.elevatorCode ? String(ctx.elevatorCode) : (ctx.missingText || 'contact host')));
  return out;
}

/* the placeholders offered in the admin editor */
export const PLACEHOLDERS = ['{room}', '{door code}', '{lock box code}', '{entrance code}', '{elevator code}'];

/* What is missing for one unit, in plain words (empty list = ready). `unit` = checkin_apartments data, `noLock` = the type has no door code box. */
export function unitProblems(typeCfg, unitCode, unit, opts = {}) {
  const u = unit || {};
  const out = [];
  const t = normalizeTypeCfg(typeCfg);
  const m = resolveAccessMethod(t, u).method;
  if (m === 'smartlock' && !opts.noLock && !u.tuyaDeviceId && !u.doorCode) out.push(unitCode + ' has no lock');
  else if (m === 'code' && !u.doorCode) out.push(unitCode + ' has no lock');
  else if (m === 'lockbox' && !u.lockboxCode) out.push(unitCode + ' has no lock');
  if (t) {
    for (const s of [...t.steps, ...t.checkoutSteps]) {
      if (s.perUnitPhoto && !(u.stepPhotos && u.stepPhotos[s.id])) { out.push(unitCode + ' needs a photo'); break; }
    }
  }
  return out;
}
