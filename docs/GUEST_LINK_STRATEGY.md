# Guest check-in links — how it works

**Your marketing URL (one link for everyone):**

`https://app.maxelaapartments.com/checkin-guest.html`

Send this in automated WhatsApp / booking messages. **Same link for every guest.** No per-guest token in the message.

---

## Two links, two purposes

| Link | Who gets it | When |
|------|-------------|------|
| **Public check-in** | Everyone | Automated message before arrival |
| **Personal link** | Primary guest only | After they finish registration (inside the app) |

They are not the same thing.

---

## Flow for a new guest

```
1. Guest receives WhatsApp:
   "Complete check-in: https://app.maxelaapartments.com/checkin-guest.html"

2. Guest opens link → search by name / booking ref → register (passport, contact)

3. After registration, app shows "Your personal link" (Copy my link):
   https://app.maxelaapartments.com/checkin-guest.html?g=abc123...

4. Guest can bookmark that personal link — opens on phone/laptop without
   re-uploading passport. Optional; not required for automated messages.
```

**You never send step 3 in bulk.** Only step 1.

---

## What `?g=` is

- Random token created at registration (stable guest ID in Firestore)
- Same guest after admin room move — link still works, WiFi/photos follow new room
- Companion guests use a different flow (`?companion=1`) — no personal token

---

## URL strategy (no v2 / v3 in the address)

**Goal:** One permanent URL like iOS app updates (1.0 → 1.1 → 1.2 inside the app).

| Today | Target |
|-------|--------|
| `checkin-guest.html` redirects to `checkin-guest-v2.html` | `checkin-guest.html` **is** the app |
| Sandboxes named `-sandbox-2`, `-v2` | Design lives in repo; **one** hosted file |
| Version in filename | Version constant in code, e.g. `GUEST_APP_VERSION = '1.2'` |

**Cutover steps (when ready):**

1. Copy sandbox-2 content → `checkin-guest.html` (replace redirect stub)
2. Set `guestLinkBase` to `https://app.maxelaapartments.com/checkin-guest.html`
3. Redirect `checkin-guest-v2.html` → `checkin-guest.html` (301) for old bookmarks
4. Delete or archive `-v2` / `-sandbox-*` files from hosting (keep in git for history)
5. Bump `GUEST_APP_VERSION` on each release — show in footer or settings

Automated messages **stay** on `checkin-guest.html` — no change to URLs you already send.

---

## Live vs new design today

- **Automated messages** → `checkin-guest.html` → currently redirects to **old v2 UI**
- **New design** → `checkin-guest-sandbox-2.html` (not live until cutover)
- Merging PRs does **not** change guest UI until step 1 above

---

## Admin / WhatsApp templates

Update templates to use only:

`https://app.maxelaapartments.com/checkin-guest.html`

Remove references to `checkin-guest-v2.html` in copy when you cut over.

---

## Related

- `shared/guest-register.js` — `buildGuestLink(baseUrl, token)`
- `shared/guest-app-version.js` — version constant for releases
- `PROJECT_ARCHIVE.md` — full project history
