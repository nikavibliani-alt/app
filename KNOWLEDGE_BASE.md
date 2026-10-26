# KNOWLEDGE_BASE.md: shared guest-facing facts (DRAFT)

**Status:** draft on branch `bot-tuning` (2026-10-17). Nothing is written to Firestore yet; the bot reads the built-in seed.
**Readers:** the WhatsApp bot today; a future Booking.com inbox answerer; any page that needs the same facts.
**Code:** `whatsapp-functions/knowledge/` (`seed.js`, `knowledgeBase.js`, `promptTemplate.js`, tests).

## Idea in one paragraph

Facts (addresses, prices, WiFi, check-in times, media links, fixed replies) live in one knowledge base (KB). Rules (tone, when to escalate, when to stay silent) stay in each answerer's prompt. The WhatsApp bot's prompt is now a template: every fact is a `{{path}}` placeholder filled from the KB. With the seed, the rendered prompt is identical, character for character, to the old prompt (a test checks the SHA-256). Change a fact in one place, and every answerer gets it.

## Where it lives

| Layer | What | Who writes |
|---|---|---|
| `knowledge/seed.js` | The facts as they were in the bot prompt on 2026-10-17, word for word, plus structured fields | Code (reviewed commits) |
| Firestore `kb_*` collections (optional) | Overrides, by id. A doc is deep-merged over the seed entry with the same id | Admin only (needs Firestore rules before use) |

`loadKnowledgeBase(db)` reads `kb_properties`, `kb_units`, `kb_unit_types`, `kb_policies` and `kb_media`, merges them over the seed, and caches the result for 5 minutes. It is read-only. On any error, or if an edit would remove a fact the prompt needs, it falls back to the seed, so the bot never stops.

## Shape

```text
properties/{propertyId}
  name, roomPrefixes[], botAnswers (true only for shartava), address, landmark, mapsUrl,
  checkInTime, checkOutTime, checkinPageUrl, addressLine, entrance{apartments,rooms},
  nearby{pharmacyKa, shopKa}, source
  ids: shartava, freedom_square, orbeliani, vgl, xcv, abashidze

unitTypes/{typeId}
  name, kitchen, balcony, maxGuests, maxBabies, beds[], bathrooms, description (the prompt's sentence)
  ids: triple, superior, threeBedroom

units/{roomCode}
  property, type, displayName  (no WiFi: see below)
  ids: 0-1..0-5, 6-1..6-4, 7-1, 7-2, 7-4, tab-1..3, orb-1..3, vgl-st1/st2/ap3/ap4, xcv-1/2, abashidze

policies/{policyId}
  appliesTo[] (property ids or "all"), reply{en, ka} (fixed replies, word for word),
  structured fields (e.g. parking.pricePerDay, cleaning.prices.room), mediaId (bot tag name)
  ids: checkin, checkout, earlyCheckin, lateCheckout, parking, bagStorage, hotWater, cleaning,
       smoking, pets, gym, booking, airportTransfer, wifi, access, gas

media/{topic}
  permanent public links (Cloudinary maxela/info/), never Meta media ids (they expire)
```

Text fragments used by the bot prompt are kept exactly as they were in the prompt (for example `policies.parking.reply.en`). Structured fields next to them (for example `policies.parking.pricePerDay: 15`) are for other readers. **When you change a fact, change both**; a test can be added per field later.

## How the WhatsApp bot uses it

1. `renderSystemPrompt(kb)` fills `promptTemplate.js`. Its fact paths are listed by `templatePaths()`.
2. `unitFactLines(kb, roomCode, wifi)` adds the guest's own unit to the guest context (type, kitchen, guest count, and the WiFi passed in), only for properties with `botAnswers: true`.
3. **WiFi is not in the KB.** The only source is the check-in page data, `checkin_apartments/{roomCode}` `wifiName` / `wifiPass` (`loadUnitWifi`, which selects only those two fields). Several units share one network (7-1, 7-2 and 7-4 use "Maxela 7-4"; 0-1..0-5 use "Superior Apartments"), so there is no pattern. Unknown unit: the bot asks for the booking name or escalates, never guesses.
4. No check-in form for the phone: `bookingLookup.js` searches `reservations` by a confirmation number or the full name the guest wrote. Found: the room and dates come from it. Not found: "new bookings take up to 10 minutes". Never assumes Shartava.
5. The bot answers only Shartava guests. For other properties the code stays silent and alerts the owner (`stayRules.js`), so their KB entries are for other readers.

## How a Booking.com answerer would use it

- Find the property from the booking's room code: `propertyIdForRoom(kb, roomCode)`.
- Answer only from `properties[id]`, `units[roomCode]`, `unitTypes[...]` and `policies` whose `appliesTo` includes the property or `"all"`.
- Keep the same safety rules as the bot: decisions (early check-in, late checkout, discounts, room changes) go to the owner. Never send door or smart lock codes; the only code guests may get is the bag storage code in `policies.bagStorage`.
- If a fact for that property is missing (for example VGL has no address yet), say the team will check. Never guess.

## Rules for the KB

- No door or smart lock codes, ever (`doorCode` and `tuyaDeviceId` fields are dropped even if a Firestore doc has them). The bag storage code is the one exception.
- Facts only, no behaviour: "when to escalate" belongs in the prompt, not here.
- Every non-seed value should carry a `source` (for example `checkin_admin/config.locationInfo`).
- Before the first Firestore write: add Firestore rules so only admins can write `kb_*`. `globals/config` is publicly readable today, so don't copy that pattern.

## Owner decisions (2026-10-17)

| Fact | Decision |
|---|---|
| Shartava address | "Zhiuli Shartava 35/37, near Clean House Market", maps link `maps.app.goo.gl/fSW3iLsu4MxghzGRA` (opens the named place 35/37; the old bot link opened only a bare pin). Same link as `checkin_admin/config.locationInfo`. |
| Parking maps link | `maps.app.goo.gl/MruPY7q5RB1trNCz9`, the parking under Carrefour City on Shartava (the old bot link opened the same place). Same link as `checkin_admin/config.parkingInfo`. |
| Cleaning price | Room 30 / Apartment 50 / 3-bedroom 70 GEL (the bot is right). The guest page service shows 70 for everyone: a website fix, still open. |
| 3-bedroom capacity | 11 guests + 1 baby (baby bed). |
| WiFi | Only from the check-in page data (exact name and password), no pattern. |
| Refund | A normal escalation (short polite reply + [ESCALATE]), not "angry". |
| New booking not found | Not in our system yet: "new bookings take up to 10 minutes, try again in about 10 minutes". In the system: the couldn't-verify flow. |
| Unknown location | Never assume Shartava: ask for the name on the booking (or the dates), else escalate. |

| Room type (18 Oct) | Booking.com / Expedia only for new bookings, prices and availability; questions about a stay are answered or escalated. Lead with what the unit has: Superior Apartment = "two rooms in total: a separate bedroom with a double bed, and a second double bed in the living room, divided by curtains. It has a kitchen and fits up to 6 guests." (`unitTypes.superior.layout`). Expected something else: apologize, explain, escalate. Photos of their unit: escalate. |
| Parking behind the building (18 Oct) | Residents only, no key, about 30 spaces for about 400 families (`policies.parking.behindBuilding`, fixed EN / KA replies for the first and the repeated question). |
| Refund in Georgian (20 Oct) | A Georgian guest always gets the Georgian reply: "შევამოწმებ და მალე მოგწერთ." + [ESCALATE]. |
| Payment questions (20 Oct) | A guest with a booking asking how or when to pay: "check and get back" + [ESCALATE]; the bot never explains payment methods. |
| Admin settings (20 Oct) | `checkin_admin/config.locationInfo` MAXELA / ROOMS / BIG_APT address = "Zhiuli Shartava 35/37, near Clean House Market" (same 35/37 maps link as the bot); `parkingInfo.BIG_APT.parkingMapsUrl` = the Carrefour garage link. |
| Checked in (26 Oct) | A guest who says they have checked in / settled in gets only a short warm wish: "Hi, have a comfortable stay, and if you need anything, just message me." / Georgian reference 36. Georgian replies never open with "კარგია" or "სიამოვნებით" ("არაფრის, სიამოვნებით" only answers a plain thank you). A guest-context line (`languageHint.js`) tells the model when the newest message is in Latin letters, so the Georgian sentence does not pull English guests into Georgian. |

The prompt test (`knowledgeBase.test.js`) lists each of these changes word for word; undoing them gives back the original prompt exactly.
