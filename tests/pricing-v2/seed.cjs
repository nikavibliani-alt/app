// Test data shaped like the real documents (pricing_config, pricing_calm_daily, pricing_shadow_daily, ...).
const NOW_ISO = '2026-10-11T08:00:00Z';          // 12:00 in Tbilisi, Sunday 11 Oct 2026
const TODAY = '2026-10-11';
const add = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = iso => new Date(iso + 'T00:00:00Z').getUTCDay();

const BASE = {   // [GEL min,start,max] [USD min,start,max]  (mid season)
  XCV_1: [[130, 155, 190], [34, 41, 50]], XCV_2: [[150, 175, 210], [38, 46, 58]],
  VGL_ST: [[120, 150, 185], [30, 38, 47]], VGL_AP: [[140, 170, 210], [35, 43, 54]],
  ROOMS: [[70, 95, 130], null], MAXELA: [[95, 130, 170], null], BIG_APT: [[200, 260, 330], [60, 75, 95]],
  FREEDOM: [[90, 120, 160], [25, 35, 45]], ORBE_1: [[170, 210, 270], [50, 60, 80]], ORBE_2: [null, [80, 100, 130]],
};
const UNITS = {XCV_1: 1, XCV_2: 1, VGL_ST: 2, VGL_AP: 2, ROOMS: 5, MAXELA: 7, BIG_APT: 1, FREEDOM: 3, ORBE_1: 2, ORBE_2: 1};
const FACTOR = {low: 0.85, mid: 1, xmas_low: 0.95, high: 1.15, peak: 1.3, new_year: 1.6};
const r5 = x => Math.round(x / 5) * 5;

function rulesDoc() {
  const d = {priceRules: {}, startPrices: {}, eurRules: {}, startPricesEur: {}, dateOverrides: [{from: '12-20', to: '12-27', season: 'high'}, {from: '12-28', to: '01-06', season: 'new_year'}]};
  for (const [rt, [g, u]] of Object.entries(BASE)) for (const [s, f] of Object.entries(FACTOR)) {
    if (g) { (d.priceRules[rt] ??= {})[s] = {min: r5(g[0] * f), max: r5(g[2] * f)}; (d.startPrices[rt] ??= {})[s] = r5(g[1] * f); }
    if (u) { (d.eurRules[rt] ??= {})[s] = {min: Math.round(u[0] * f), max: Math.round(u[2] * f)}; (d.startPricesEur[rt] ??= {})[s] = Math.round(u[1] * f); }
  }
  return d;
}

// one date record, shaped like pricing_calm_daily / pricing_shadow_daily
function dayRec(rt, i, iso, cur, over = {}) {
  const b = BASE[rt][cur === 'GEL' ? 0 : 1], units = UNITS[rt];
  const wk = [5, 6].includes(dow(iso));
  let p = b[1] * (wk ? 1.08 : 0.95); p = cur === 'GEL' ? r5(p) : Math.round(p);
  const avail = over.avail !== undefined ? over.avail : (units > 1 ? units - (i % 3 === 0 ? 1 : 0) : 1);
  return {mh: over.mh ?? p, new: over.new ?? p, target: p, min: b[0], max: b[2], status: 'behind', avail, kind: over.kind || 'move',
    why: over.why || [`Start price ${b[1]}`, 'Selling slower than usual'], ...over.extra};
}
function dailyDoc(rt, old) {
  const dates = {};
  for (let i = 0; i < 90; i++) {
    const iso = add(TODAY, i), units = UNITS[rt];
    for (const cur of ['GEL', 'USD']) {
      if (!BASE[rt][cur === 'GEL' ? 0 : 1]) continue;
      const over = {};
      if (i === 1 || i === 2 || i === 9 || i === 10) over.avail = 0;            // booked nights
      if (rt === 'VGL_ST' && i === 0) over.avail = 0;                          // tonight: full
      if (rt === 'XCV_2' && i === 6) { over.kind = 'manual'; over.new = cur === 'GEL' ? 170 : 45; over.mh = over.new; }
      if (rt === 'XCV_2' && i === 8) over.kind = 'protected';
      if (rt === 'XCV_2' && i === 0) { over.kind = 'hold'; over.new = BASE[rt][0][0]; over.why = ['Arrival day: never lowered further']; }
      if (old) { const b = BASE[rt][cur === 'GEL' ? 0 : 1]; over.mh = i % 2 ? b[0] : b[2]; over.new = cur === 'GEL' ? r5(b[1] * (rt === 'MAXELA' ? 1.09 : 1.04)) : Math.round(b[1] * 1.04); }
      dates[`${iso}|${cur}`] = dayRec(rt, i, iso, cur, over);
    }
  }
  return {day: TODAY, rt, last_run: TODAY + 'T09:03:00', dates};
}

function seedDocs() {
  const docs = {};
  docs['pricing_config/control'] = {paused: false};
  docs['pricing_config/rules'] = rulesDoc();
  docs['pricing_config/engine_v2'] = {settings: {room_types: {
    XCV_1: {engine: 'live', style: 'normal', window_days: 180}, XCV_2: {engine: 'live', style: 'normal', window_days: 180},
    VGL_ST: {engine: 'live', style: 'normal', window_days: 180}, VGL_AP: {engine: 'live', style: 'normal', window_days: 180},
    // the six old rooms are "only calculating" here, so the old-way screens stay testable
    ROOMS: {engine: 'test'}, MAXELA: {engine: 'test'}, BIG_APT: {engine: 'test'}, FREEDOM: {engine: 'test'}, ORBE_1: {engine: 'test'}, ORBE_2: {engine: 'test'}}, date_rules: []}};
  docs['pricing_calm_runs/r1'] = {ts: TODAY + 'T09:03:00', ok: true, paused: false, failed_portals: [], writes: 4};
  docs['pricing_log/l1'] = {timestamp: new Date('2026-10-11T08:55:00Z'), changes_count: 3};
  for (const rt of Object.keys(BASE)) {
    const old = ['ROOMS', 'MAXELA', 'BIG_APT', 'FREEDOM', 'ORBE_1', 'ORBE_2'].includes(rt);
    docs[`${old ? 'pricing_shadow_daily' : 'pricing_calm_daily'}/${TODAY}_${rt}`] = dailyDoc(rt, old);
  }
  docs['pricing_events/event_2026-10-31'] = {label: 'City event', multiplier: 1.2, status: 'approved'};
  docs['pricing_events/event_2026-11-14'] = {label: 'Concert', multiplier: 1.15, status: 'pending'};
  docs['pricing_locks/XCV_1_2026-10-17'] = {manual_lock: true};
  const r = docs['pricing_config/rules'];
  docs['pricing_weekly/2026-W42'] = {property_id: 'maxela', week_key: '2026-W42', from: '2026-10-06', to: '2026-10-12', ts: '2026-10-12T21:00:00',
    numbers: {data_notes: ['The history log of price changes only exists since 2026-10-12, so price moves, drops and cancellations before that are not counted.'],
      rooms: {MAXELA: {bookings_made: 6, nights_sold: 11, avg_sold_price_gel: 142, avg_start_gel: 150, price_up: 9, price_down: 14, nights_hit_min: 2, last3_drops: 3, last3_drops_sold: 2, cancel_drops_tonight: 1, cancel_drops_tonight_sold: 1, cancellations: 2},
              XCV_2: {bookings_made: 0, nights_sold: 0}},
      all: {runs: 18, urgent_runs: 1, channel_push_failures: {EXPEDIA: 1}, watchdog_red_days: 1, watchdog_days_recorded: 5, ideas: {finished: 14, right: 9, wrong: 3, unclear: 2, tracking: 4}, twin: {finished: 2, avg_difference_pct: 5}}},
    report: {headline: 'A calm week: 11 nights sold in Maxela and one Expedia push failed.', checked: true, edited: 1, removed: [{id: 'worked.1', text: 'x', why: 'y'}],
      worked: [{text: 'The tonight drop sold: 1 of 1 cancelled nights was rebooked.', refs: []}], didnt: [{text: 'The Expedia push failed 1 time.', refs: []}],
      upgrades: [{text: 'Look at why Expedia failed (1 failure this week).', refs: [], edited: true}]}};
  docs['pricing_weekly/2026-W41'] = {property_id: 'maxela', week_key: '2026-W41', from: '2026-09-29', to: '2026-10-05', ts: '2026-10-05T21:00:00', numbers: {rooms: {}, all: {}, data_notes: []}, report: {headline: 'Thin week.', checked: false, worked: [], didnt: [], upgrades: []}};
  docs['pricing_proposals/ideaA'] = {type: 'startPrice', property: 'XCV_2', season: 'mid', current: r.startPrices.XCV_2.mid, suggested: 165, change_pct: -6, reasoning: 'Only 2 of 22 November nights are booked. Last year by today: 9.', status: 'pending', ts: '2026-10-10T10:00:00'};
  docs['pricing_proposals/ideaB'] = {type: 'ceilingEur', property: 'VGL_ST', season: 'high', current: r.eurRules.VGL_ST.high.max, suggested: r.eurRules.VGL_ST.high.max + 5, reasoning: '5 High-season nights reached your maximum and were booked within 2 days.', status: 'pending', ts: '2026-10-10T09:00:00'};
  docs['pricing_proposals/ideaC'] = {type: 'startPriceEur', property: 'VGL_ST', season: 'high', current: r.startPricesEur.VGL_ST.high, suggested: r.startPricesEur.VGL_ST.high + 2, reasoning: '8 of 10 High-season weekends last year were booked more than a month ahead.', status: 'pending', ts: '2026-10-10T08:00:00',
    // an idea made after the evidence was added: what it looked at, as it was that day
    evidence: {version: 1, made_on: '2026-10-10', uses_last_year: true, stretch: {from: '2026-12-20', to: '2026-12-27', nights: 8},
      later: [{from: '2027-05-01', to: '2027-06-30'}], looked_at: {from: '2026-12-20', to: '2026-12-27', nights: 8},
      booked: ['2026-12-22', '2026-12-26'], empty: ['2026-12-20', '2026-12-21', '2026-12-23', '2026-12-24', '2026-12-25', '2026-12-27'], no_price: [],
      booked_count: 2, known_nights: 8, units: 2,
      last_year: {available: true, from: '2025-12-20', to: '2025-12-27', as_of: '2025-10-10', nights: 8, room_nights: 16, booked_nights: 13, booked_by_that_day: 5}}};
  docs['pricing_proposals/oldD'] = {type: 'floor', property: 'MAXELA', season: 'low', current: 80, suggested: 85, reasoning: 'x', status: 'approved', approved_at: new Date('2026-10-06T10:00:00Z'), ts: '2026-10-06T08:00:00'};
  docs['pricing_proposals/oldF'] = {type: 'startPrice', property: 'ROOMS', season: 'mid', current: 95, suggested: 100, reasoning: 'x', status: 'rejected', rejection_reason: 'Replaced by a newer idea', replaced_by: 'fresh_set', rejected_at: new Date('2026-10-09T10:00:00Z'), ts: '2026-10-04T08:00:00'};
  docs['pricing_proposals/oldE'] = {type: 'startPriceEur', property: 'VGL_ST', season: 'high', current: 40, suggested: 45, reasoning: 'x', status: 'rejected', rejection_reason: 'Too early to tell', rejected_at: new Date('2026-10-05T10:00:00Z'), ts: '2026-10-05T08:00:00'};
  return docs;
}
module.exports = {seedDocs, NOW_ISO, TODAY, add, dow, BASE, UNITS};
