/**
 * House rules — shared by checkin-guest.html (guest rules page) and checkin-admin.html (editor + preview).
 * Data lives in checkin_admin/config.houseRules[GROUP]; see docs/GUEST_ADMIN_PLAN.md ("House rules editor").
 *
 *   houseRules = { [GROUP]: { texts:{title,intro,signLabel,button,disclaimer} (each {en,ka,ru,ar}), signature:bool,
 *     rules:[{id,title:{..},desc:{..},icon,iconImage,notAllowed,required,highlight,apartments:[]}], version, updatedAt } }
 *
 * Nothing saved for a group -> defaultHouseRules(group): exactly today's page (texts copied from the guest page).
 */
import { featherIcon, FEATHER_ICONS } from './feather-icons.js';

export const HR_LANGS = ['en', 'ka', 'ru', 'ar'];
export const HR_GROUPS = [
  { id: 'ROOMS', label: 'Rooms' }, { id: 'MAXELA', label: 'Maxela' }, { id: 'BIG_APT', label: 'Big Apt' },
  { id: 'FREEDOM', label: 'Freedom' }, { id: 'ORBELIANI', label: 'Orbeliani' }, { id: 'VGL', label: 'VGL' }, { id: 'XCV', label: 'XCV' },
];
export const NO_SMOKING_IMG = 'assets/icons/no-smoking.png';
const HIGHLIGHT_STYLE = 'color:#92400e;background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:8px 12px;';

/* Today's hand-drawn rule icons (kept exactly) + Lucide icons from shared/feather-icons.js */
const CUSTOM_ICONS = {
  'rule-noise': { stroke: 1.6, inner: '<path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M16 9l5 5M21 9l-5 5"/>' },
  'rule-care': { stroke: 1.6, inner: '<path d="M3 10.5L12 4l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5z"/>' },
  'rule-card': { stroke: 1.8, inner: '<path d="m2 21 9.6-9.6"></path><path d="m7.5 15.5 2.3 2.3a1 1 0 0 1 0 1.4l-2.1 2.1a1 1 0 0 1-1.4 0L4 19"></path><circle cx="15.5" cy="7.5" r="5.5"></circle>' },
};
/* icons offered in the admin picker (names that exist in feather-icons.js are kept) */
const ICON_WISH = ['rule-noise', 'cigarette-off', 'rule-care', 'rule-card', 'dog', 'paw-print',
  'party-popper', 'flame', 'users', 'clock', 'moon', 'trash-2', 'footprints', 'door-closed', 'wine-off', 'car', 'baby',
  'camera-off', 'droplets', 'zap', 'shield-alert', 'lock', 'wifi', 'info'];
export const ICON_CHOICES = ICON_WISH.filter((n) => CUSTOM_ICONS[n] || FEATHER_ICONS[n]);

const TEXT = {
  title: {"en": "House rules", "ka": "სახლის წესები", "ru": "Правила проживания", "ar": "قواعد المنزل"},
  intro: {"en": "Please read and accept before your stay", "ka": "გთხოვთ წაიკითხოთ და დაეთანხმოთ", "ru": "Пожалуйста, прочитайте и примите перед заездом", "ar": "يرجى القراءة والموافقة قبل إقامتك"},
  signLabel: {"en": "Type your full name to sign", "ka": "ხელმოსაწერად ჩაწერეთ თქვენი სრული სახელი", "ru": "Введите ваше полное имя для подписи", "ar": "اكتب اسمك الكامل للتوقيع"},
  button: {"en": "I agree — Continue", "ka": "ვეთანხმები — გაგრძელება", "ru": "Согласен — Продолжить", "ar": "أوافق — متابعة"},
  disclaimer: {"en": "This acknowledgment confirms you have read and agreed to the house rules for your stay. Platform cancellation terms apply.", "ka": "ეს დადასტურება ადასტურებს, რომ წაიკითხეთ და დაეთანხმეთ სახლის წესებს. პლატფორმის გაუქმების პირობები მოქმედებს.", "ru": "Это подтверждение означает, что вы прочитали и согласились с правилами проживания. Действуют условия отмены платформы.", "ar": "يؤكد هذا الإقرار أنك قرأت ووافقت على قواعد الإقامة. تُطبَّق شروط الإلغاء الخاصة بالمنصة."},
};
const RULE_TEXT = {
  noise: { title: {"en": "No parties or excessive noise", "ka": "ყოველგვარი წვეულება და ხმაური აკრძალულია", "ru": "Без вечеринок и громкого шума", "ar": "ممنوع الحفلات والضوضاء الزائدة"}, desc: {"en": "Quiet hours 22:00–10:00. No parties or events.", "ka": "სიჩუმის საათები 22:00–10:00. წვეულებები და ღონისძიებები აკრძალულია.", "ru": "Тихие часы 22:00–10:00. Вечеринки и мероприятия запрещены.", "ar": "ساعات الهدوء 22:00–10:00. لا حفلات أو فعاليات."} },
  smoke: { title: {"en": "No smoking inside the apartment", "ka": "ბინაში მოწევა აკრძალულია", "ru": "Курение в квартире запрещено", "ar": "ممنوع التدخين داخل الشقة"}, desc: {"en": "Strictly prohibited indoors. Fine applies.", "ka": "შენობის შიგნით მკაცრად აკრძალულია. გამოიყენება ჯარიმა.", "ru": "Строго запрещено в помещении. Применяется штраф.", "ar": "محظور تماماً في الأماكن المغلقة. تُطبَّق غرامة."} },
  care: { title: {"en": "Take care of the apartment", "ka": "გთხოვთ, იზრუნოთ ბინაზე", "ru": "Берегите квартиру", "ar": "اعتنِ بالشقة"}, desc: {"en": "Leave the apartment in reasonable condition. Dishes washed, trash disposed, belongings removed. Excessive mess may incur a cleaning fee.", "ka": "დატოვეთ ბინა გონივრულ მდგომარეობაში. ჭურჭელი გარეცხილი, ნაგავი გატანილი, ნივთები წაღებული. ზედმეტი არეულობის შემთხვევაში შესაძლოა დაგეკისროთ დასუფთავების საფასური.", "ru": "Оставьте квартиру в разумном состоянии. Посуда вымыта, мусор вынесен, вещи забраны. За чрезмерный беспорядок может взиматься плата за уборку.", "ar": "اتركوا الشقة في حالة معقولة. الأطباق مغسولة، والقمامة مُخرَجة، والأغراض مُزالة. قد تُفرض رسوم تنظيف على الفوضى المفرطة."} },
  card: { title: {"en": "Entrance Card & Key", "ka": "შესასვლელი ბარათი და გასაღები", "ru": "Карта входа и ключ", "ar": "بطاقة المدخل والمفتاح"}, desc: {"en": "Entrance card and key are provided. Loss or damage fee: 50 GEL per item.", "ka": "გადაცემულია შესასვლელი ბარათი და გასაღები. დაკარგვის ან დაზიანების გადასახადი: 50 ლარი თითო ერთეულზე.", "ru": "Предоставляется карта входа и ключ. Штраф за потерю или повреждение: 50 GEL за каждый предмет.", "ar": "يتم توفير بطاقة المدخل والمفتاح. رسوم الفقدان أو التلف: 50 GEL لكل قطعة."} },
};
/* only English exists today for the highlighted quiet-hours text: other languages fall back to English, as today */
const NOISE_HIGHLIGHT_DESC = { en: 'Quiet hours 22:00\u201310:00. No running or jumping inside.', ka: '', ru: '', ar: '' };
/* apartments of the MAXELA listing (the highlighted noise rule is for 6-4 only, the normal one for the rest) */
const MAXELA_ROOMS = ['6-1', '6-2', '6-4', '7-1', '7-2', '7-3', '7-4'];

const clone = (o) => JSON.parse(JSON.stringify(o));

export function emptyLangs() { return { en: '', ka: '', ru: '', ar: '' }; }
export function pick(obj, lang) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  return (obj[lang] && String(obj[lang]).trim()) ? obj[lang] : (obj.en || '');
}

export function defaultHouseRules(group, opts = {}) {
  const entranceCard = opts.entranceCard === undefined ? group === 'FREEDOM' : !!opts.entranceCard;
  const rule = (id, extra = {}, textKey = id) => ({
    id, title: clone(RULE_TEXT[textKey].title), desc: clone(RULE_TEXT[textKey].desc),
    icon: '', iconImage: '', notAllowed: false, required: true, highlight: false, scope: 'all', apartments: [], ...extra,
  });
  const rules = [];
  if (group === 'MAXELA') {
    /* the normal noise rule is "all except 6-4", so a new Maxela apartment gets it automatically */
    rules.push(rule('noise', { icon: 'rule-noise', scope: 'except', apartments: ['6-4'] }));
    rules.push(rule('noise-quiet', { icon: 'rule-noise', highlight: true, desc: clone(NOISE_HIGHLIGHT_DESC), scope: 'only', apartments: ['6-4'] }, 'noise'));
  } else if (group === 'BIG_APT') {
    rules.push(rule('noise-quiet', { icon: 'rule-noise', highlight: true, desc: clone(NOISE_HIGHLIGHT_DESC) }, 'noise'));
  } else {
    rules.push(rule('noise', { icon: 'rule-noise' }));
  }
  rules.push(rule('smoke', { iconImage: NO_SMOKING_IMG }));
  rules.push(rule('care', { icon: 'rule-care' }));
  if (entranceCard) rules.push(rule('card', { icon: 'rule-card' }));
  return { texts: clone(TEXT), signature: true, rules, version: 'default' };
}

/* scope of a rule: 'all' | 'only' | 'except' (older saved rules: a non-empty apartments list means 'only') */
export function ruleScope(r) {
  const apts = Array.isArray(r.apartments) ? r.apartments : [];
  if (r.scope === 'all' || r.scope === 'only' || r.scope === 'except') return r.scope;
  return apts.length ? 'only' : 'all';
}
export function ruleShownIn(r, room) {
  const apts = Array.isArray(r.apartments) ? r.apartments : [];
  const sc = ruleScope(r);
  if (sc === 'only') return apts.includes(room);
  if (sc === 'except') return !apts.includes(room);
  return true;
}
/* give repeated rule ids new ids (edits the list in place); returns true when something changed */
export function uniqueRuleIds(rules) {
  const seen = new Set();
  let changed = false;
  (rules || []).forEach((r, i) => {
    let id = String(r.id || '').trim() || ('r' + (i + 1));
    if (seen.has(id)) {
      let n = 2;
      while (seen.has(id + '-' + n)) n++;
      id = id + '-' + n;
    }
    if (id !== r.id) { r.id = id; changed = true; }
    seen.add(id);
  });
  return changed;
}

/* config + group + booking room code -> page texts + the rules shown for that room, in order */
export function resolveHouseRules(cfg, group, room, opts = {}) {
  const saved = cfg && cfg.houseRules && cfg.houseRules[group];
  const hasSaved = !!(saved && Array.isArray(saved.rules));
  const base = hasSaved ? saved : defaultHouseRules(group, opts);
  const texts = { ...clone(TEXT), ...(hasSaved && saved.texts ? saved.texts : {}) };
  const all = clone(Array.isArray(base.rules) ? base.rules : []);
  uniqueRuleIds(all);
  const rules = all.filter((r) => ruleShownIn(r, room));
  return {
    texts,
    signature: base.signature !== false,
    rules,
    allRules: all,
    version: hasSaved ? String(saved.version || 'custom') : 'default',
    fromConfig: hasSaved,
  };
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const safeId = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '');

function iconInner(name, size) {
  const c = CUSTOM_ICONS[name];
  if (c) return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${c.stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${c.inner}</svg>`;
  if (FEATHER_ICONS[name]) return featherIcon(name, size, 1.6);
  return '';
}
/* icon column of a rule: uploaded/png image, or a named icon; "not allowed" adds a red circle + slash over it */
export function ruleIconHtml(rule) {
  const noEntry = rule.notAllowed === true;
  const img = (rule.iconImage || '').trim();
  const inner = img
    ? `<img src="${esc(img)}" alt="" width="28" height="28" loading="lazy" draggable="false">`
    : iconInner(rule.icon || 'info', 20);
  if (noEntry) {
    return `<div class="rule-icon rule-icon--noentry" aria-hidden="true"><span class="rule-noentry__art">${inner}</span>`
      + '<svg class="rule-noentry__sign" viewBox="0 0 28 28" fill="none" stroke="#B3261E" stroke-width="2.2" stroke-linecap="round"><circle cx="14" cy="14" r="12"/><path d="M5.5 5.5l17 17"/></svg></div>';
  }
  if (img) return `<div class="rule-icon rule-icon--sign" aria-hidden="true">${inner}</div>`;
  return `<div class="rule-icon" aria-hidden="true">${inner}</div>`;
}
export function isNoEntryRule(rule) { return rule.notAllowed === true || (rule.iconImage || '') === NO_SMOKING_IMG; }

/* The rules list. opts: {interactive:true -> required rules get onclick toggleRule, checked:{id:true}} */
export function renderRulesList(rules, lang, opts = {}) {
  const tick = '<div class="rule-cb"><svg width="12" height="10" viewBox="0 0 12 10" fill="none"><path d="M1 5l3.5 3.5L11 1" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';
  return (rules || []).map((r) => {
    const id = safeId(r.id);
    const req = r.required === true;
    const cls = ['rule-item'];
    if (isNoEntryRule(r)) cls.push('smoking');
    if (!req) cls.push('rule-item--info');
    if (req && opts.checked && opts.checked[r.id]) cls.push('checked');
    const click = req && opts.interactive ? ` onclick="window.toggleRule('${id}')"` : '';
    const title = esc(pick(r.title, lang));
    const desc = esc(pick(r.desc, lang));
    return `<div class="${cls.join(' ')}" id="rule-${id}" data-rule="${id}"${click}>`
      + (req ? tick : '')
      + ruleIconHtml(r)
      + `<div class="rule-body"><div class="rule-title">${title}</div>`
      + (desc ? `<div class="rule-sub"${r.highlight ? ` style="${HIGHLIGHT_STYLE}"` : ''}>${desc}</div>` : '')
      + '</div></div>';
  }).join('');
}

/* the record saved with the guest: exactly what was shown, plus the English version */
export function agreementRules(rules, lang) {
  return (rules || []).map((r) => ({
    id: r.id,
    title: pick(r.title, lang), desc: pick(r.desc, lang),
    titleEn: (r.title && r.title.en) || '', descEn: (r.desc && r.desc.en) || '',
    required: r.required === true,
  }));
}
