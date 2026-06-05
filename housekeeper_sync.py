import requests
from bs4 import BeautifulSoup
from datetime import datetime
import json, base64, time, math, hashlib

HOTEL_CODE = 'freedo45'
USERNAME   = 'komp'
PASSWORD   = 'Katleti1'
SA_FILE    = '/tmp/service_account.json'
PROJECT_ID = 'sleepy-5c962'
FIREBASE_URL = f'https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents'

ROOM_MAP = {
    '0-1': '0-1', '0-2': '0-2', '0-3': '0-3', '0-4': '0-4', '0-5': '0-5',
    'M-6-1': '6-1', 'M-6-2': '6-2', 'M-6-3': '6-3', 'M-6-4': '6-4',
    'M-7-1': '7-1', 'M-7-2': '7-2', 'M-7-4': '7-4',
    'T-1': 'tab-1', 'T-2': 'tab-2', 'T-3': 'tab-3',
    'Midamo 1': 'orb-1', 'Midamo 2': 'orb-2', 'Midamo 3': 'orb-3',
}

PLACEHOLDER_NAMES = ['direct reserv', 'walk in', 'walk-in', 'walkin', 'fake fake']

def get_token():
    with open(SA_FILE) as f:
        sa = json.load(f)
    now = int(time.time())
    header = base64.urlsafe_b64encode(json.dumps({'alg':'RS256','typ':'JWT'}).encode()).rstrip(b'=')
    claim  = base64.urlsafe_b64encode(json.dumps({
        'iss': sa['client_email'],
        'scope': 'https://www.googleapis.com/auth/datastore',
        'aud': 'https://oauth2.googleapis.com/token',
        'iat': now, 'exp': now+3600
    }).encode()).rstrip(b'=')
    from cryptography.hazmat.primitives import serialization, hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    key = serialization.load_pem_private_key(sa['private_key'].encode(), password=None)
    sig = base64.urlsafe_b64encode(key.sign(header+b'.'+claim, padding.PKCS1v15(), hashes.SHA256())).rstrip(b'=')
    jwt = (header+b'.'+claim+b'.'+sig).decode()
    r = requests.post('https://oauth2.googleapis.com/token', data={
        'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        'assertion': jwt
    })
    return r.json()['access_token']

def normalize(s):
    import unicodedata
    s = unicodedata.normalize('NFD', s.lower())
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = ''.join(c if c.isalnum() else ' ' for c in s)
    return ' '.join(sorted(s.split()))

def update_firestore(token, res_id, fields):
    url = FIREBASE_URL + f'/reservations/{res_id}'
    paths = list(fields.keys()) + ['roomCode', 'manualRoom', 'hkSyncedAt']
    mask = '&'.join(f'updateMask.fieldPaths={p}' for p in paths)
    body = {'fields': {}}
    for k, v in fields.items():
        if isinstance(v, bool): body['fields'][k] = {'booleanValue': v}
        elif isinstance(v, int): body['fields'][k] = {'integerValue': str(v)}
        elif isinstance(v, str): body['fields'][k] = {'stringValue': v}
    body['fields']['manualRoom'] = {'booleanValue': True}
    body['fields']['hkSyncedAt'] = {'timestampValue': datetime.utcnow().isoformat()+'Z'}
    r = requests.patch(url+'?'+mask, json=body, headers={'Authorization': f'Bearer {token}'})
    return r.status_code

def fetch_reservations(token):
    all_docs = []
    page_token = None
    while True:
        url = FIREBASE_URL + '/reservations?pageSize=300'
        if page_token:
            url += f'&pageToken={page_token}'
        r = requests.get(url, headers={'Authorization': f'Bearer {token}'})
        data = r.json()
        if 'documents' in data:
            all_docs.extend(data['documents'])
        page_token = data.get('nextPageToken')
        if not page_token:
            break
    return all_docs

print(f'Starting housekeeping sync at {datetime.now().strftime("%Y-%m-%d %H:%M")}')

session = requests.Session()
r = session.get('https://login.minihotel.cloud/login.aspx')
soup = BeautifulSoup(r.text, 'html.parser')
session.post('https://login.minihotel.cloud/login.aspx', data={
    '__EVENTTARGET': 'LoginButton',
    '__EVENTARGUMENT': '',
    '__VIEWSTATE': soup.find('input', {'id': '__VIEWSTATE'})['value'],
    '__VIEWSTATEGENERATOR': soup.find('input', {'id': '__VIEWSTATEGENERATOR'})['value'],
    '__EVENTVALIDATION': soup.find('input', {'id': '__EVENTVALIDATION'})['value'],
    'txt_hotel_code': HOTEL_CODE,
    'txt_username': USERNAME,
    'txt_password': PASSWORD,
    'hdd_language': 'en',
    'txt_agent_username': '',
    'txt_agent_password': '',
})
print('Logged in')

today = datetime.now().strftime('%d-%m-%Y')
r2 = session.get('https://ssl20.minihotelpms.com/Reports/rpt_housekeeping.aspx')
soup2 = BeautifulSoup(r2.text, 'html.parser')
r3 = session.post('https://ssl20.minihotelpms.com/Reports/rpt_housekeeping.aspx', data={
    '__EVENTTARGET': 'ctl00$MainContent$btn_show_report',
    '__EVENTARGUMENT': '',
    '__VIEWSTATE': soup2.find('input', {'id': '__VIEWSTATE'})['value'],
    '__VIEWSTATEGENERATOR': soup2.find('input', {'id': '__VIEWSTATEGENERATOR'})['value'],
    '__EVENTVALIDATION': soup2.find('input', {'id': '__EVENTVALIDATION'})['value'],
    'ctl00$MainContent$dp_date': today,
    'ctl00$MainContent$dd_reportType': 'ALL',
    'ctl00$MainContent$dd_roomType': '*',
    'ctl00$MainContent$txt_fromRoom': '',
    'ctl00$MainContent$txt_toRoom': '',
})

soup3 = BeautifulSoup(r3.text, 'html.parser')
vs = soup3.find('input', {'id': '__VIEWSTATE'})['value']
decoded = base64.b64decode(vs)
start = decoded.find(b'[{')
end = decoded.rfind(b'}]') + 2
room_data = json.loads(decoded[start:end])
print(f'Got {len(room_data)} rooms')

token = get_token()
docs = fetch_reservations(token)
print(f'Loaded {len(docs)} reservations')

today_str = datetime.now().strftime('%Y-%m-%d')
name_index = {}
for doc in docs:
    fields = doc.get('fields', {})
    guest = fields.get('guest', {}).get('stringValue', '')
    checkin = fields.get('checkin', {}).get('stringValue', '')
    checkout = fields.get('checkout', {}).get('stringValue', '')
    cancelled = fields.get('cancelled', {}).get('booleanValue', False)
    if cancelled or not guest or not checkin or not checkout:
        continue
    if checkin > today_str or checkout < today_str:
        continue
    norm = normalize(guest)
    if norm not in name_index:
        name_index[norm] = []
    name_index[norm].append(doc)

updated = skipped = no_match = 0
for room in room_data:
    room_raw = room.get('RoomNumber', '')
    room_code = ROOM_MAP.get(room_raw)
    if not room_code:
        skipped += 1
        continue
    first = room.get('FirstName', '').strip()
    last  = room.get('LastName', '').strip()
    combined = f'{first} {last}'.strip()
    if any(p in combined.lower() for p in PLACEHOLDER_NAMES):
        skipped += 1
        continue
    norm = normalize(combined)
    candidates = name_index.get(norm, [])
    if not candidates:
        print(f'No match: {combined} -> {room_code}')
        no_match += 1
        continue
    if len(candidates) > 1:
        print(f'Ambiguous: {combined}')
        skipped += 1
        continue
    doc = candidates[0]
    res_id = doc['name'].split('/')[-1]
    status = update_firestore(token, res_id, {'roomCode': room_code})
    if status < 300:
        print(f'{combined} -> {room_code}')
        updated += 1
    else:
        print(f'Failed {res_id}')

print(f'Done: {updated} updated, {skipped} skipped, {no_match} no match')