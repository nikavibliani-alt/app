#!/usr/bin/env python3
"""
expedia_api_fields_check.py  --  READ-ONLY. Where (if anywhere) do the fields of the
Expedia "new reservation" email live in the MiniHotel API responses?

Looks at ACTIVE Expedia bookings only, in three read-only places:
  list    = GET  /api/Reservations?FromDate=..&ToDate=..          (what the sync uses)
  detail  = GET  /api/Reservations/{number}                        (sync: OTA remarks)
  info    = POST /ajax/request_reservation_info.aspx/get_reservation_info (sync: phone/email/country)

PRIVACY (public repo + public Actions logs): prints only key names / section names,
FOUND / NOT FOUND, counts, and four non-personal values (rate model, brand, rate name,
rate acquisition type). Never prints card data, CVV, names, emails, phones, addresses.
Output guard drops any line with '@' or 7+ digits (reservation numbers / money allowed).
Writes nothing anywhere.
"""

import os, re, sys, time, json, datetime, importlib.util, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(name, fname):
    sp_ = importlib.util.spec_from_file_location(name, os.path.join(ROOT, fname))
    m = importlib.util.module_from_spec(sp_)
    sp_.loader.exec_module(m)
    return m


mh = _load('mh_sync', 'minihotel_reservation_sync.py')       # constants only; main() not run
fc = _load('fraud_check', 'scripts/expedia_fraud_check.py')  # quiet login + output guard
sp, login_quiet = fc.sp, fc.login_quiet

PAUSE = 0.5
BRANDS = ('A-Hotels.com', 'Hotels.com', 'Vrbo', 'Orbitz', 'Travelocity', 'Wotif', 'Expedia')
LABEL_KEYS = ('name', 'key', 'label', 'fieldname', 'title', 'code')
VALUE_KEYS = ('value', 'val', 'text')


# ---------- walk a JSON value into (path, value) pairs; never keeps values for printing ----------
def seg(k):
    k = str(k)
    return '<id>' if re.fullmatch(r'\d+', k) else k


def walk(obj, path, out):
    if isinstance(obj, dict):
        low = {str(k).lower(): k for k in obj}
        lab = next((obj[low[k]] for k in LABEL_KEYS if k in low and isinstance(obj[low[k]], str)), None)
        val = next((low[k] for k in VALUE_KEYS if k in low), None)
        if lab and val and len(obj) <= 4 and re.fullmatch(r'[A-Za-z][A-Za-z0-9 _./-]{0,40}', lab):
            out.append((f'{path}{{{lab}}}', obj[val]))        # label/value pair style
            return
        for k, v in obj.items():
            walk(v, f'{path}.{seg(k)}' if path else seg(k), out)
    elif isinstance(obj, list):
        if not obj:
            out.append((path + '[]', None))
        for v in obj:
            walk(v, path + '[]', out)
    else:
        out.append((path, obj))


def filled(v):
    return v not in (None, '', 0, 0.0, False, [], {}) and str(v).strip() not in ('', '0')


# ---------- the email fields: key-name regex (on path) and/or text label regex (inside string values) ----------
FIELDS = [
    ('Rate model (HotelCollect/ExpediaCollect)', r'ratemodel|paymentmodel|collecttype|paymenttype|rate_model', r'Rate\s*Model\s*[:=]\s*([^\n|]*)'),
    ('"Hotel Collect Booking Collect Payment From Guest" request', None, r'Hotel Collect Booking Collect Payment From Guest'),
    ('Brand (e.g. A-Hotels.com)', r'brand', r'Brand\s*[:=]\s*([^\n|]*)'),
    ('Rate name', r'ratename|rate_name|rateplan|rate_plan|ratecode', r'Rate\s*Name\s*[:=]\s*([^\n|]*)'),
    ('Rate acquisition type', r'acquisition', r'Rate\s*Acquisition\s*Type\s*[:=]\s*([^\n|]*)'),
    ('Credit card holder name', r'holder|nameoncard|cardname|ccname', r'Card\s*Holder(?:\s*Name)?\s*[:=]'),
    ('Card country', r'(card|credit).*country|country.*(card|credit)', r'Card\s*Country\s*[:=]'),
    ('Card postal code', r'(card|credit).*(zip|postal)|(zip|postal).*(card|credit)', r'Card\s*(?:Postal|Zip)\s*Code\s*[:=]'),
    ('CVV', r'cvv|cvc|securitycode|cardcode', r'CVV|CVC'),
    ('Guest email', r'email|e_mail', None),
    ('Guest phone', r'phone|mobile|tel$', None),
    ('Address', r'address|street|city', None),
    ('Country', r'country', None),
    ('Adults / children', r'adult|child|guestscount|occupan|pax', r'Adult\s*Count|Child(?:ren)?\s*Count'),
    ('Multi-room / primary traveler', r'primarytravel|primaryguest|traveler|traveller|members|roomcount|rooms\b', r'Primary\s*Travel(?:l)?er|Room\s*\d+\s*of\s*\d+'),
]
VALUE_PRINT = {'Rate model (HotelCollect/ExpediaCollect)', 'Brand (e.g. A-Hotels.com)',
               'Rate name', 'Rate acquisition type'}


def safe_value(field, v):
    """Only the four non-personal values are ever returned, and only if they look like one."""
    v = re.sub(r'\s+', ' ', str(v)).strip()
    if field.startswith('Rate model'):
        m = re.fullmatch(r'(Hotel|Expedia)\s*Collect', v, re.I)
        return re.sub(r'\s+', '', m.group(0)) if m else '(other value)'
    if field.startswith('Brand'):
        return next((b for b in BRANDS if b.lower() == v.lower()), '(other value)')
    if re.fullmatch(r'[A-Za-z0-9 &/()+._-]{1,40}', v):
        return v
    return '(other value)'


def scan(api, obj, hits, labels, bookno):
    """hits[field][(api, location)] -> {'present': set(bookno), 'filled': set(bookno), 'vals': Counter}"""
    pairs = []
    walk(obj, '', pairs)
    for path, v in pairs:
        last = path.rsplit('.', 1)[-1] if '{' not in path else path
        keytxt = last.replace('[]', '').lower()
        for name, key_re, text_re in FIELDS:
            target = path.replace('[]', '').lower() if name.startswith('Card') else keytxt
            if key_re and re.search(key_re, target):
                loc = (api, path.replace('{', '{').rstrip())
                h = hits[name][loc]
                h['present'].add(bookno)
                if filled(v):
                    h['filled'].add(bookno)
                    if name in VALUE_PRINT and isinstance(v, (str, int, float)):
                        h['vals'][safe_value(name, v)] += 1
            if text_re and isinstance(v, str):
                m = re.search(text_re, v, re.I)
                if m:
                    loc = (api, path + ' (text line inside value)')
                    h = hits[name][loc]
                    h['present'].add(bookno)
                    h['filled'].add(bookno)
                    if name in VALUE_PRINT and m.groups() and m.group(1).strip():
                        h['vals'][safe_value(name, m.group(1))] += 1
        if isinstance(v, str) and 'remarks' in path.lower():
            for lab in set(re.findall(r'(?:^|\n|\|)\s*([A-Za-z][A-Za-z ]{1,28}?)\s*:', v)):
                labels[(api, path)][lab.strip().lower()] += 1
    return pairs


def inventory(inv, api, pairs, bookno):
    for path, v in pairs:
        k = (api, re.sub(r'\{.*?\}', '{label}', path) if False else path)
        e = inv[k]
        e['seen'].add(bookno)
        if filled(v):
            e['filled'].add(bookno)


def main():
    now = datetime.datetime.utcnow()
    lo = (now - datetime.timedelta(days=30)).strftime('%Y-%m-%d')
    hi = (now + datetime.timedelta(days=365)).strftime('%Y-%m-%d')
    session = login_quiet()

    # ---- list API (live, right now) ----
    r = session.get('https://emea5.hotelpms.cloud/api/Reservations'
                    f'?FromDate={lo}T20:00:00.000Z&ToDate={hi}T20:00:00.000Z',
                    headers={'Accept': 'application/json'}, timeout=60)
    if r.status_code != 200:
        sp(f'list API error {r.status_code}')
        return
    data = r.json()
    sp('list API top-level keys:', sorted(data.keys()))
    items = data.get('reservations', [])
    exp = [x for x in items if (x.get('source') or '').lower() == 'expedia']
    sp(f'list API: {len(items)} reservations, {len(exp)} from Expedia (window {lo} to {hi})')
    sp('Expedia status codes in list API:',
       dict(collections.Counter(f"{x.get('status')}/{x.get('statusDescription')}" for x in exp)))
    active = [x for x in exp
              if x.get('status', '') in mh.VALID_STATUSES
              and 'cancel' not in (x.get('statusDescription') or '').lower()]
    sp(f'active Expedia bookings used: {len(active)}')
    bynum = collections.defaultdict(list)
    for x in active:
        bynum[str(x.get('reservationNumber', '')).strip()].append(x)
    bynum.pop('', None)
    sp(f'distinct active reservation numbers: {len(bynum)}; with more than one room line in list API: '
       f'{sum(1 for v in bynum.values() if len(v) > 1)}')

    hits = {name: collections.defaultdict(lambda: {'present': set(), 'filled': set(), 'vals': collections.Counter()})
            for name, _, _ in FIELDS}
    labels = collections.defaultdict(collections.Counter)
    inv = collections.defaultdict(lambda: {'seen': set(), 'filled': set()})
    statuses = collections.Counter()

    for rn, lines in sorted(bynum.items()):
        # list API: every line of the booking
        for ln in lines:
            pairs = scan('list', ln, hits, labels, rn)
            inventory(inv, 'list', pairs, rn)
        # detail API
        try:
            d = session.get(f'https://emea5.hotelpms.cloud/api/Reservations/{rn}',
                            headers={'Accept': 'application/json'}, timeout=15)
            statuses[('detail', d.status_code)] += 1
            if d.status_code == 200:
                pairs = scan('detail', d.json(), hits, labels, rn)
                inventory(inv, 'detail', pairs, rn)
        except Exception as e:
            statuses[('detail', type(e).__name__)] += 1
        time.sleep(PAUSE)
        # info endpoint (what the sync uses for phone / email / country)
        try:
            i = session.post('https://emea5.hotelpms.cloud/ajax/request_reservation_info.aspx/get_reservation_info',
                             json={'reservation_id': rn},
                             headers={'Content-Type': 'application/json', 'Accept': 'application/json'}, timeout=15)
            statuses[('info', i.status_code)] += 1
            if i.status_code == 200:
                outer = i.json()
                raw = outer.get('d', '{}')
                inner = json.loads(raw) if isinstance(raw, str) else raw
                pairs = scan('info', inner, hits, labels, rn)
                inventory(inv, 'info', pairs, rn)
        except Exception as e:
            statuses[('info', type(e).__name__)] += 1
        time.sleep(PAUSE)

    n = len(bynum)
    sp('call results:', {f'{a}:{b}': c for (a, b), c in statuses.items()})

    sp('\nFIELD RESULTS (location = api / section.key ; "filled" = non-empty on N of %d bookings)' % n)
    for name, _, _ in FIELDS:
        locs = hits[name]
        any_filled = any(h['filled'] for h in locs.values())
        sp(f'\n{name}: {"FOUND" if any_filled else "NOT FOUND"}'
           + ('' if any_filled or not locs else ' (key exists but always empty)'))
        for (api, loc), h in sorted(locs.items(), key=lambda kv: -len(kv[1]['filled']))[:8]:
            vals = f' values={dict(h["vals"])}' if h['vals'] else ''
            sp(f'   {api}: {loc}  present {len(h["present"])}, filled {len(h["filled"])}{vals}')

    sp('\nREMARK TEXT LABELS (label names only) per place:')
    for (api, path), c in labels.items():
        sp(f'   {api}: {path}: {sorted(c)}')

    sp('\nFULL KEY INVENTORY (api | path | on how many bookings | filled on how many)')
    for (api, path), e in sorted(inv.items()):
        sp(f'   {api} | {path} | {len(e["seen"])} | {len(e["filled"])}')


if __name__ == '__main__':
    main()
    print(f'Guard: {fc.DROPPED} output line(s) dropped')
