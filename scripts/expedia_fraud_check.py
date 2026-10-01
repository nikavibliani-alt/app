#!/usr/bin/env python3
"""
expedia_fraud_check.py  --  READ-ONLY one-off analysis of Expedia bookings.

Compares known-fake vs normal Expedia reservations using the MiniHotel detail
API (remarks.printed) plus Firestore reservation docs.

Writes nothing anywhere (no Firestore writes, no MiniHotel changes, no files).
Imports minihotel_reservation_sync.py without editing it (its main() is guarded).

PRIVACY: the repo and Actions logs are public. This script never prints guest
names, emails, phones, addresses, card holder names, card numbers or CVV.
It only prints reservation numbers, dates, amounts and yes/no flags.

Env: FIREBASE_SERVICE_ACCOUNT, MINIHOTEL_USER, MINIHOTEL_PASS, MINIHOTEL_HOTEL
"""

import os, sys, re, time, datetime, importlib.util, collections
import requests
from bs4 import BeautifulSoup

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location(
    'mh_sync', os.path.join(ROOT, 'minihotel_reservation_sync.py'))
mh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mh)  # only defines functions; main() is not run

KNOWN_FAKE = {'2551153955'}
DAYS = 120
PAUSE = 0.5


# ---------- quiet MiniHotel login (same steps as the sync, without cookie printing) ----------
def login_quiet():
    s = requests.Session()
    s.headers.update({'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                                    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'})
    r = s.get('https://login.minihotel.cloud/login.aspx', timeout=30)
    soup = BeautifulSoup(r.text, 'html.parser')

    def f(i):
        t = soup.find('input', {'id': i})
        return t['value'] if t and t.has_attr('value') else ''

    resp = s.post('https://login.minihotel.cloud/login.aspx', data={
        'LoginButton': 'Login', '__EVENTARGUMENT': '',
        '__VIEWSTATE': f('__VIEWSTATE'), '__VIEWSTATEGENERATOR': f('__VIEWSTATEGENERATOR'),
        '__EVENTVALIDATION': f('__EVENTVALIDATION'),
        'txt_hotel_code': mh.HOTEL_CODE, 'txt_username': mh.USERNAME, 'txt_password': mh.PASSWORD,
        'hdd_language': 'en', 'txt_agent_username': '', 'txt_agent_password': '',
    }, allow_redirects=True, timeout=30)
    if 'login' in resp.url.lower() or 'dashboard' not in resp.url.lower():
        raise RuntimeError('MiniHotel login failed')
    sp('[AUTH] login ok')
    return s


# ---------- helpers ----------
def norm_tokens(s):
    return set(t for t in re.sub(r'[^a-z0-9 ]', ' ', (s or '').lower()).split() if t)


def names_differ(a, b):
    """yes/no/None. Compare only; nothing printed."""
    ta, tb = norm_tokens(a), norm_tokens(b)
    if not ta or not tb:
        return None
    return not (ta <= tb or tb <= ta)


def label_value(text, label_regex):
    m = re.search(r'(?:^|\n|\|)\s*(?:' + label_regex + r')\s*[:=\-]\s*([^\n|]*)', text, re.I)
    return m.group(1).strip() if m else None


COUNTRY_ISO = {'UNITED STATES': 'US', 'USA': 'US', 'UNITED KINGDOM': 'GB', 'UK': 'GB',
               'GREAT BRITAIN': 'GB', 'GERMANY': 'DE', 'FRANCE': 'FR', 'ITALY': 'IT',
               'SPAIN': 'ES', 'NETHERLANDS': 'NL', 'CANADA': 'CA', 'AUSTRALIA': 'AU',
               'ISRAEL': 'IL', 'POLAND': 'PL', 'TURKEY': 'TR', 'RUSSIA': 'RU',
               'UKRAINE': 'UA', 'GEORGIA': 'GE', 'INDIA': 'IN', 'BRAZIL': 'BR',
               'SWEDEN': 'SE', 'NORWAY': 'NO', 'DENMARK': 'DK', 'FINLAND': 'FI',
               'AUSTRIA': 'AT', 'SWITZERLAND': 'CH', 'BELGIUM': 'BE', 'IRELAND': 'IE',
               'CZECH REPUBLIC': 'CZ', 'CZECHIA': 'CZ', 'PORTUGAL': 'PT', 'JAPAN': 'JP'}
POSTAL = {
    'US': r'\d{5}(-\d{4})?', 'CA': r'[A-Z]\d[A-Z] ?\d[A-Z]\d',
    'GB': r'[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}', 'DE': r'\d{5}', 'FR': r'\d{5}',
    'IT': r'\d{5}', 'ES': r'\d{5}', 'NL': r'\d{4} ?[A-Z]{2}', 'AU': r'\d{4}',
    'PL': r'\d{2}-\d{3}', 'IL': r'\d{5}(\d{2})?', 'TR': r'\d{5}', 'RU': r'\d{6}',
    'UA': r'\d{5}', 'IN': r'\d{6}', 'BR': r'\d{5}-?\d{3}', 'SE': r'\d{3} ?\d{2}',
    'NO': r'\d{4}', 'DK': r'\d{4}', 'FI': r'\d{5}', 'AT': r'\d{4}', 'CH': r'\d{4}',
    'BE': r'\d{4}', 'IE': r'[A-Z]\d{2} ?[A-Z\d]{4}', 'CZ': r'\d{3} ?\d{2}',
    'PT': r'\d{4}-\d{3}', 'JP': r'\d{3}-?\d{4}', 'GE': r'\d{4}',
}


def to_iso(c):
    if not c:
        return None
    c = c.strip().upper()
    return c if len(c) == 2 else COUNTRY_ISO.get(c, c)


def postal_wrong(country, postal):
    """yes/no/None (None = cannot tell)."""
    iso = to_iso(country)
    if not iso or iso not in POSTAL:
        return None
    if not postal:
        return True
    return not re.fullmatch(POSTAL[iso], postal.strip().upper())


def phone_fake(phone):
    """yes/no. Empty, or repeated digits like 1111111, or a straight run like 123456."""
    digits = re.sub(r'\D', '', phone or '')
    if not digits:
        return True
    if re.search(r'(\d)\1{5,}', digits) or len(set(digits)) <= 2:
        return True
    return any(run in digits for run in ('0123456', '1234567', '2345678', '3456789', '9876543'))


def collect_json(obj, key_part, out):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == 'remarks':
                continue
            if key_part in k.lower() and isinstance(v, (str, int)):
                out.append(str(v))
            collect_json(v, key_part, out)
    elif isinstance(obj, list):
        for v in obj:
            collect_json(v, key_part, out)


def yn(v):
    return 'n/a' if v is None else ('yes' if v else 'no')


def analyse(printed, detail_json, guest_name, doc_count):
    t = printed or ''
    out = {}

    rm = label_value(t, r'Rate\s*Model|Payment\s*Model|Collect\s*Type')
    if rm:
        out['model'] = re.sub(r'\s+', '', rm)[:20]
    elif re.search(r'Expedia\s*Collect', t, re.I):
        out['model'] = 'ExpediaCollect'
    elif re.search(r'Hotel\s*Collect', t, re.I):
        out['model'] = 'HotelCollect'
    else:
        out['model'] = 'not found'

    out['collect_msg'] = bool(re.search(r'Hotel Collect Booking Collect Payment From Guest', t, re.I))

    brand = 'not found'
    for b in ('A-Hotels.com', 'Hotels.com', 'Vrbo', 'Orbitz', 'Travelocity', 'Wotif', 'Expedia'):
        if re.search(re.escape(b), t, re.I):
            brand = b
            break
    out['brand'] = brand

    holder = label_value(t, r'Card\s*Holder(?:\s*Name)?|Cardholder(?:\s*Name)?|Name\s*on\s*Card')
    out['holder_found'] = holder is not None
    out['holder_differs'] = names_differ(holder, guest_name) if holder else None

    ccountry = label_value(t, r'Card\s*Country|Billing\s*Country|Country')
    postal = label_value(t, r'Card\s*Postal\s*Code|Billing\s*Postal\s*Code|Postal\s*Code|Zip(?:\s*Code)?')
    out['card_country'] = to_iso(ccountry) or 'n/a'
    out['postal_wrong'] = postal_wrong(ccountry, postal) if ccountry else None

    pt = label_value(t, r'Primary\s*Travel(?:l)?er(?:\s*Name)?')
    out['traveler_differs'] = names_differ(pt, guest_name) if pt else None
    out['multiroom'] = doc_count > 1 or bool(re.search(r'Room\s*\d+\s*of\s*\d+', t, re.I))

    phones = []
    collect_json(detail_json, 'phone', phones)
    ph = label_value(t, r'Phone(?:\s*Number)?|Tel(?:ephone)?|Mobile')
    if ph is not None:
        phones.append(ph)
    out['phone_fake'] = phone_fake(max(phones, key=len)) if phones else True

    addrs, ctrs = [], []
    collect_json(detail_json, 'address', addrs)
    collect_json(detail_json, 'country', ctrs)
    a = label_value(t, r'(?:Billing\s*)?Address(?:\s*Line\s*\d)?|Street')
    if a:
        addrs.append(a)
    if ccountry:
        ctrs.append(ccountry)
    out['addr_country_empty'] = not any(x.strip() for x in addrs) and not any(x.strip() for x in ctrs)
    return out



# ---------- output guard: the repo and Actions logs are PUBLIC ----------
DROPPED = 0


def sp(*args, allowed=()):
    """Print a line only if it has no '@' and no run of 7+ digits.
    Reservation numbers (passed in `allowed`) and money amounts (like 1234567.00)
    are removed before the digit check. Dropped lines are only counted."""
    global DROPPED
    line = ' '.join(str(a) for a in args)
    check = line
    for a in allowed:
        check = check.replace(a, '')
    check = re.sub(r'\d+\.\d{2}\b', '', check)
    if '@' in check or re.search(r'\d{7,}', check):
        DROPPED += 1
        return
    print(line)

def main():
    now = datetime.datetime.utcnow()
    lo = (now - datetime.timedelta(days=DAYS)).strftime('%Y-%m-%d')
    hi = (now + datetime.timedelta(days=DAYS)).strftime('%Y-%m-%d')
    sp(f'Window (check-in): {lo} to {hi}')

    db = mh.init_firestore()

    # Firestore: Expedia docs in window, grouped by reservation number (read-only)
    groups = collections.defaultdict(list)
    for snap in db.collection('reservations').where('source', '==', 'expedia').stream():
        d = snap.to_dict() or {}
        ci = d.get('checkin') or ''
        if lo <= ci <= hi:
            d['_id'] = snap.id
            groups[str(d.get('reservationNumber', '')).strip()].append(d)
    groups.pop('', None)
    sp(f'Expedia reservations in window: {len(groups)}')

    session = login_quiet()
    rows, label_counter, key_sample = [], collections.Counter(), None

    for i, (rn, docs) in enumerate(sorted(groups.items(), key=lambda kv: kv[1][0].get('checkin', ''))):
        d = docs[0]
        guest = d.get('guest') or ''
        printed, jd, err = '', {}, ''
        try:
            r = session.get(f'https://emea5.hotelpms.cloud/api/Reservations/{rn}',
                            headers={'Accept': 'application/json'}, timeout=15)
            if r.status_code == 200:
                jd = r.json()
                printed = (jd.get('remarks') or {}).get('printed') or ''
                if key_sample is None:
                    key_sample = sorted(jd.keys())
                for lab in set(re.findall(r'(?:^|\n|\|)\s*([A-Za-z][A-Za-z ]{1,28}?)\s*:', printed)):
                    label_counter[lab.strip().lower()] += 1
            else:
                err = f'http{r.status_code}'
        except Exception as e:
            err = type(e).__name__
        time.sleep(PAUSE)

        a = analyse(printed, jd, guest, len(docs))

        ids = list(dict.fromkeys([x['_id'] for x in docs] + [rn]))
        online = False
        for sid in ids:
            if list(db.collection('checkin_guests').where('matchedReservationId', '==', sid).limit(1).stream()):
                online = True
                break

        ci, cd = d.get('checkin') or '', d.get('creationDate') or ''
        try:
            lead = (datetime.date.fromisoformat(ci) - datetime.date.fromisoformat(cd)).days
        except Exception:
            lead = 'n/a'
        debit, credit = d.get('debit', 0) or 0, d.get('credit', 0) or 0
        rows.append({
            'res': rn + (' *KNOWN FAKE*' if rn in KNOWN_FAKE else ''),
            'created': cd or 'n/a', 'checkin': ci, 'nights': d.get('nights', 'n/a'), 'lead': lead,
            'total': f"{debit:.2f} {d.get('currency', '')}".strip(),
            'paid': 'yes' if credit else 'no',
            'status': f"{d.get('status', '')}/{d.get('statusDescription', '')}",
            'online_ci': yn(online),
            'model': a['model'], 'collect_msg': yn(a['collect_msg']), 'brand': a['brand'],
            'holder_diff': yn(a['holder_differs']), 'card_ctry': a['card_country'],
            'zip_wrong': yn(a['postal_wrong']), 'multiroom': yn(a['multiroom']),
            'traveler_diff': yn(a['traveler_differs']), 'phone_fake': yn(a['phone_fake']),
            'addr_empty': yn(a['addr_country_empty']), 'err': err or ('no remarks' if not printed else ''),
        })

    cols = ['res', 'created', 'checkin', 'nights', 'lead', 'total', 'paid', 'status', 'online_ci',
            'model', 'collect_msg', 'brand', 'holder_diff', 'card_ctry', 'zip_wrong', 'multiroom',
            'traveler_diff', 'phone_fake', 'addr_empty', 'err']
    sp('\nTABLE (sorted by check-in)')
    sp(' | '.join(cols))
    for r in rows:
        sp(' | '.join(str(r[c]) for c in cols), allowed=[r['res'].split(' ')[0]])

    # ---- summary ----
    sp('\nSUMMARY')
    sp('rate model counts:', dict(collections.Counter(r['model'] for r in rows)))
    fake = [r for r in rows if 'KNOWN FAKE' in r['res']]
    others = [r for r in rows if 'KNOWN FAKE' not in r['res']]
    sp('known fake found in window:', bool(fake))
    flags = ['collect_msg', 'brand', 'holder_diff', 'card_ctry', 'zip_wrong', 'multiroom',
             'traveler_diff', 'phone_fake', 'addr_empty', 'paid', 'online_ci', 'model']
    if fake:
        for c in flags:
            v = fake[0][c]
            same = sum(1 for r in others if r[c] == v)
            sp(f'  {c}: fake={v}; same value on {same} of {len(others)} others')
    sp('rows with no remarks / errors:', sum(1 for r in rows if r['err']))
    # Diagnostics for parser tuning: field LABELS only (never values), seen on 3+ bookings
    sp('top-level keys of detail API:', key_sample)
    sp('remark labels seen on 3+ bookings:',
          sorted(l for l, n in label_counter.items() if n >= 3))


if __name__ == '__main__':
    main()
    print(f'Guard: {DROPPED} output line(s) dropped')
