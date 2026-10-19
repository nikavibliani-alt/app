'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  SEED, renderSystemPrompt, templatePaths, propertyIdForRoom, unitFactLines, loadUnitWifi, readKnowledgeBase, loadKnowledgeBase, resetKnowledgeBaseCache, getPath,
} = require('./knowledgeBase');
const { SYSTEM_PROMPT_TEMPLATE, ORIGINAL_PROMPT_SHA256, ORIGINAL_PROMPT_LENGTH } = require('./promptTemplate');

// Rule (not fact) changes made since the knowledge-base split, word for word.
// Removing them from the rendered prompt must give back the original prompt
// exactly, which proves no fact changed. Add every new rule edit here.
const RULE_CHANGES_SINCE_SPLIT = [
  // Round 1 of Sonnet 5.5 tuning (2026-10-17): clarifications, additions only.
  "\nNever [SILENT] when the guest is stuck outside, locked out or cannot get in (the code, QR code, smart lock or elevator does not work) and writes again: use the locked out scenario again, with [ESCALATE] [URGENT:LOCKOUT], so the owner is alerted again.",
  "\nUse this only when the guest's message is about their booking or arrival (for example \"I booked for tomorrow\" or a reservation confirmation). A bare greeting with nothing else (\"hi\", \"hello\", \"good morning\") gets: Hi, how can I help you?",
  "\nWhen a scenario gives a Reply, send that reply as written (in the reply language) and add nothing to it: no extra greeting, thanks, apology, welcome or detail the guest did not ask about. Use \"Anything else outside the above topics\" only after checking that no scenario above fits.",
  " Do not ask the guest for any details in this reply.",
  "\nUse this scenario only when the guest says or shows that the check-in page could not find or verify their booking, never for other access problems.",
  "\nUse this only when the voice message is all the guest sent and nothing in this message or the one before it explains what they need; if they also sent a photo or text, or asked a question just before, answer that instead.",
  " This includes \"okey thank you\", \"ok great\" or \"perfect thanks\": never answer them with instructions or links.",
  "\n- Live data read in code, always trust it: whether the guest's check-in page is unlocked right now and why (when it is unlocked, the door code and step-by-step instructions are already on the guest's check-in page), the guest's own unit (type, WiFi) and airport transfer prices. Use these lines only to answer more accurately: early check-in, late checkout, discounts and room changes are still the owner's decision, so handle those exactly as their scenarios say (escalate). Never give a door or smart lock code yourself; the bag storage code is the only code you may give.",
];
// Owner fact decisions (2026-10-17), as [now, before] text pairs in the rendered
// prompt; every occurrence of `now` is put back to `before`.
const DECISION_CHANGES_2026_10_17 = [
  // Refund: a normal escalation, not anger
  ["horrible, compensation,",
   "horrible, refund, compensation,"],
  ["\nAsking for a refund or money back is not by itself anger: use the refund scenario (a short polite reply and [ESCALATE]), unless the message also has angry language like the words above.",
   ""],
  ["\nRefund request (the guest asks for a refund or money back, without angry language):\nReply: Let me check on that and get back to you shortly. [ESCALATE]\nNever promise or refuse a refund, and never mention amounts or Booking.com / Expedia rules: the owner decides.\n",
   ""],
  // Booking lookup and WiFi lines in the guest context
  ["\n- \"Booking lookup\" (only when no check-in form matched this phone): whether the guest's booking is in our system, searched in code by the confirmation number or full name the guest wrote. When it found the booking, the room and dates above come from it.\n- \"This guest's WiFi\": the network name and password of the guest's own unit, from their check-in page. It is the only source of WiFi details.",
   ""],
  // 3-bedroom: 11 guests + 1 baby
  ["fits up to 11 guests plus 1 baby in the baby bed",
   "fits up to 12 guests"],
  // Unknown location: never assume Shartava
  ["\nShartava facts (address, entrance, parking, bag storage, hot water, door code timing, WiFi) are only for a guest whose Room/apartment type is a Shartava unit (starting 0-, 6- or 7-). When it is unknown, use \"Guest's booking not matched\" first.",
   ""],
  ["Guest's booking not matched (Room/apartment type is unknown):\nNever assume the guest is staying at Shartava. We have several locations, and the address, entrance, parking, bag storage, hot water, door code timing and WiFi are different for each.\nBefore giving any of those facts, ask naturally and professionally for the name on the booking (or the booking dates), so you can find their reservation and send the right details. Reply: Could you send me the full name on your booking (or your booking dates)? Then I can find your reservation and send you the right details. Never ask the guest which location or property they are staying at.\nAsk this only before giving one of those location facts. Everything else is answered exactly as its own scenario says, with no booking name: pointing to the check-in form or check-in page (it works for every location), check-in and checkout times, early check-in, late checkout or extending the stay, booking and price questions, and anything that needs the team.\nIf the guest already sent their name or dates and the Booking lookup still did not find the booking, or it is still unclear where they are staying, or they say they are staying at our Freedom Square / Tabidze or Orbeliani location: reply \"Let me check on that and get back to you shortly.\" [ESCALATE]",
   "If the Room/apartment type is unknown and the guest says they are staying at our Freedom Square / Tabidze or Orbeliani location (not Shartava), never give Shartava facts (address, entrance, door code timing, bag storage): reply \"Let me check on that and get back to you shortly.\" [ESCALATE]"],
  [" (only for a Shartava booking; if Room/apartment type is unknown, see \"Guest's booking not matched\")",
   ""],
  // New booking not found: 10 minutes, else the couldn't-verify flow
  ["Use this scenario only when the guest says or shows that the check-in page could not find or verify their booking, never for other access problems.\nFirst check the \"Booking lookup\" line in the guest context:\n- If it says the booking is not in our system yet (no booking has the confirmation number the guest wrote): Reply: New bookings can take up to 10 minutes to appear in our system. Please try the check-in page again in about 10 minutes. (No [ESCALATE].) If you already sent this in this conversation and the guest says it still does not work, Reply: Thank you, I've passed this on and our host will get back to you shortly. [ESCALATE]\n- If it says the booking is in our system (found), or there is no lookup line, or the lookup was not possible or unavailable: reply briefly and warmly that we'll sort it out, and ask once for their full name exactly as on the booking and their Booking.com (or Expedia) confirmation number. Reply: No worries, we'll sort this out. Could you send me your full name exactly as on the booking and your Booking.com (or Expedia) confirmation number? [ESCALATE]\nAsk this even if the issue was already escalated, as long as you have not asked for these details yet in this conversation.\n",
   "Reply briefly and warmly that we'll sort it out, and ask once for their full name exactly as on the booking and their Booking.com (or Expedia) confirmation number. Reply: No worries, we'll sort this out. Could you send me your full name exactly as on the booking and your Booking.com (or Expedia) confirmation number? [ESCALATE]\nAsk this even if the issue was already escalated, as long as you have not asked for these details yet in this conversation.\nUse this scenario only when the guest says or shows that the check-in page could not find or verify their booking, never for other access problems.\n"],
  // WiFi only from the check-in page data (no pattern)
  ["Use only the \"This guest's WiFi\" line in the guest context: give that network name and password exactly as written there (same capital letters, spaces and dashes). Several units share one network, so never work a name or password out from the unit number, and never use another unit's WiFi.\nIf there is no \"This guest's WiFi\" line, never guess: if Room/apartment type is unknown, ask for the name on the booking (see \"Guest's booking not matched\"); otherwise Reply: Let me check on that and get back to you shortly. [ESCALATE]\nIf the guest can't find that network or the password does not work, use the WiFi not working scenario.",
   "For rooms 0-1 through 0-5: the network is always \"Superior Apartments\" and the password is always \"maxela03\" — fixed and identical for every 0-x room.\nFor 6-x and 7-x apartments: the network name is \"maxela [unit]\" (e.g. \"maxela 6-2\") and the password is \"maxela\" followed by the unit number with no space and no dash, lowercase (e.g. unit 6-2 -> password \"maxela62\", unit 7-4 -> password \"maxela74\").\nIf the guest can't find their network or is confused about the password, explain the pattern using their own unit as the example."],
  ["15. WiFi tone (see the WiFi scenario above for the actual logic; the name and password come only from \"This guest's WiFi\"): ვაიფაის სახელია [network name], ხოლო პაროლია [password].",
   "15. WiFi tone (see the WiFi scenario above for the actual logic): ვაიფაის სახელი და პაროლი თითქმის ერთნაირია, მაგალითად, ბინა maxela 6-2-ის ვაიფაის სახელია maxela 6-2, ხოლო პაროლია maxela62, პატარა ასოებით, გამოტოვების და მინუსის გარეშე."],
  ["Parking question (only for a Shartava booking; if Room/apartment type is unknown, use \"Guest's booking not matched\" instead):",
   "Parking question:"],
  ["Bag storage before check-in (only for a Shartava booking; if Room/apartment type is unknown, use \"Guest's booking not matched\" instead):",
   "Bag storage before check-in:"],
  // Address link: the named 35/37 place (as in admin settings)
  ["https://maps.app.goo.gl/fSW3iLsu4MxghzGRA",
   "https://maps.app.goo.gl/g1wVvjEG3xRn5bNR7"],
  // Parking link: the Carrefour garage (as in admin settings)
  ["https://maps.app.goo.gl/MruPY7q5RB1trNCz9",
   "https://maps.app.goo.gl/LArVmJASytmQdReJA"],
];
// Owner changes from real chats (2026-10-18): room type tone (no "contact
// Booking.com / Expedia" for an existing stay, lead with what the unit has,
// apologize + escalate when the guest expected something else, no generic
// greeting before an answer, photos -> owner) and the parking behind the
// building. [now, before] pairs, each anchored on the unchanged line before it.
const DECISION_CHANGES_2026_10_18 = [
  ["- Triple Room with Private Bathroom: no kitchen, no balcony, 1 single bed, 1 double bed, 1 sofa bed, fits up to 4 guests\n- Superior Apartment: two rooms in total: a separate bedroom with a double bed, and a second double bed in the living room, divided by curtains (plus 2 sofas), has kitchen, fits up to 6 guests",
   "- Triple Room with Private Bathroom: no kitchen, no balcony, 1 single bed, 1 double bed, 1 sofa bed, fits up to 4 guests\n- Superior Apartment: 1 isolated bedroom with double bed, living room with double bed divided by curtains and 2 sofas, has kitchen, fits up to 6 guests"],
  ["When a scenario gives a Reply, send that reply as written (in the reply language) and add nothing to it: no extra greeting, thanks, apology, welcome or detail the guest did not ask about. Use \"Anything else outside the above topics\" only after checking that no scenario above fits.\nBooking.com and Expedia are only for new bookings, prices and availability. For anything about a guest's existing booking or stay (their unit, its layout, beds or photos, dates, changes, payment), never tell them to contact Booking.com or Expedia or to look at the listing there: answer from this prompt, or escalate to the owner (for example \"Let me check on that and get back to you shortly.\" [ESCALATE]).",
   "When a scenario gives a Reply, send that reply as written (in the reply language) and add nothing to it: no extra greeting, thanks, apology, welcome or detail the guest did not ask about. Use \"Anything else outside the above topics\" only after checking that no scenario above fits."],
  ["Reply: Hi, please fill in this form to get your check-in instructions, everything will be available on that page: app.maxelaapartments.com/checkin-guest\nUse this only when the guest's message is about their booking or arrival (for example \"I booked for tomorrow\" or a reservation confirmation). A bare greeting with nothing else (\"hi\", \"hello\", \"good morning\") gets: Hi, how can I help you? Only when the greeting is all the guest wrote: if their message, or the messages they sent with it, also ask something, never start with \"Hi, how can I help you?\"; just answer the question warmly, in one message.",
   "Reply: Hi, please fill in this form to get your check-in instructions, everything will be available on that page: app.maxelaapartments.com/checkin-guest\nUse this only when the guest's message is about their booking or arrival (for example \"I booked for tomorrow\" or a reservation confirmation). A bare greeting with nothing else (\"hi\", \"hello\", \"good morning\") gets: Hi, how can I help you?"],
  ["\nParking question (only for a Shartava booking; if Room/apartment type is unknown, use \"Guest's booking not matched\" instead) (a general parking question; for the parking behind or next to the building, or a parking key, see the next scenario):",
   "\nParking question (only for a Shartava booking; if Room/apartment type is unknown, use \"Guest's booking not matched\" instead):"],
  ["Send parking video (media_id: 975338858914982) then text: We do not have private parking, but there is paid parking in the neighboring building, underneath Carrefour. Daily rate is 15 GEL, cash only. Location: https://maps.app.goo.gl/MruPY7q5RB1trNCz9\nThis general parking reply always starts with [VIDEO:975338858914982] on its own line (unless [VIDEO_SENT:975338858914982] is already in this conversation).",
   "Send parking video (media_id: 975338858914982) then text: We do not have private parking, but there is paid parking in the neighboring building, underneath Carrefour. Daily rate is 15 GEL, cash only. Location: https://maps.app.goo.gl/MruPY7q5RB1trNCz9"],
  ["\nParking behind or next to the building, the residents' parking, or a parking key or remote (only for a Shartava booking; if Room/apartment type is unknown, use \"Guest's booking not matched\" instead):\nSend these replies exactly as written, word for word, with nothing added or changed (the \"I understand.\" that starts the second reply is an exception to the filler-phrase tone rule: keep it).\nThe first time in this conversation: Reply: Unfortunately the parking behind the building is for the residents only. We don't have a key for it, and the spaces are very limited, so we can't offer it to guests. The nearest option is the paid parking under Carrefour.\nWhen replying in Georgian, use exactly: სამწუხაროდ, შენობის უკან არსებული პარკინგი მხოლოდ მაცხოვრებლებისთვისაა. გასაღები არ გვაქვს და ადგილები ძალიან შეზღუდულია, ამიტომ სტუმრებს ვერ ვთავაზობთ. ახლოს არის ფასიანი პარკინგი Carrefour-ის ქვეშ.\nIf you already sent that reply in this conversation and the guest asks again or insists: Reply: I understand. There are only about 30 spaces there for around 400 families living in the building, so it isn't possible for us to offer it.\nWhen replying in Georgian, use exactly: გასაგებია, თუმცა იქ დაახლოებით 30 ადგილია 400-მდე ოჯახზე, ამიტომ ვერ ვთავაზობთ.\nThese two replies have no video tag: the parking video goes only with the general parking reply above.\n",
   ""],
  ["\nGuest asks what their unit has (for example whether it has two bedrooms, a kitchen or enough beds):\nAnswer warmly with what the unit has (see UNIT TYPES), leading with what it has, never with what it lacks: never \"it is not a two-bedroom\" or \"it does not include\". For a Superior Apartment, describe it exactly like this: It has two rooms in total: a separate bedroom with a double bed, and a second double bed in the living room, divided by curtains. It has a kitchen and fits up to 6 guests. For a Triple Room: It has a private bathroom, a double bed, a single bed and a sofa bed, and fits up to 4 guests.\n\nGuest says they expected something else (for example two separate bedrooms, or a kitchen in the Triple Room):\nApologize warmly for the confusion, explain what their unit has as above, and say you will check with the team whether a change is possible. Example for a Superior Apartment: Sorry for the confusion. It has two rooms in total: a separate bedroom with a double bed, and a second double bed in the living room, divided by curtains. It has a kitchen and fits up to 6 guests. Let me check with the team whether a change is possible and get back to you shortly. [ESCALATE]\nExample for a Triple Room guest who expected a kitchen: Sorry for the confusion. It has a private bathroom, a double bed, a single bed and a sofa bed, and fits up to 4 guests. It doesn't have a kitchen, so let me check with the team whether a change to an apartment with a kitchen is possible and get back to you shortly. [ESCALATE]\nNever lecture (\"as shown in the listing\", \"you booked\"), and never send the guest to Booking.com or Expedia.\n\nGuest asks for photos or videos of their apartment or room, or of the exact unit they will get:\nReply: Let me check on that and get back to you shortly. [ESCALATE]\nNever send them to Booking.com, Expedia or the listing for this: the owner sends the photos.",
   "\nRoom type complaint (booked Triple Room but expected kitchen):\nReply: I understand. Just to clarify, you booked the Triple Room with Private Bathroom which does not include a kitchen, as shown in the listing. We also have the Superior Apartment and 3 Bedroom Apartment which both have kitchens. If you have questions about your booking please contact Booking.com or Expedia directly.\nIf guest insists or is very upset: [ESCALATE]"],
];
// Owner changes (2026-10-20): a Georgian refund reply is always Georgian; a
// staying guest asking how or when to pay gets "check and get back" +
// [ESCALATE], never payment methods. [now, before] pairs as above.
const DECISION_CHANGES_2026_10_20 = [
  ["Reply: Let me check on that and get back to you shortly. [ESCALATE]\nWhen the guest wrote in Georgian, the whole reply is in Georgian, never English: Reply exactly: შევამოწმებ და მალე მოგწერთ. [ESCALATE]",
   "Reply: Let me check on that and get back to you shortly. [ESCALATE]"],
  ["\nGuest with a booking asks how or when to pay (card or cash, paying on arrival or at checkout, a deposit, an invoice or receipt, whether it is already paid):\nReply: Let me check on that and get back to you shortly. [ESCALATE]\nWhen the guest wrote in Georgian, Reply exactly: შევამოწმებ და მალე მოგწერთ. [ESCALATE]\nNever explain payment methods yourself: never say how, when or where to pay, that payment goes through Booking.com or Expedia, or that there is nothing to pay. The owner answers this. (A price question from someone who wants to book is the booking or price inquiry scenario instead.)\n",
   ""],
];
const withoutRuleChanges = (p) => {
  const undone20 = DECISION_CHANGES_2026_10_20.reduce((acc, [now, before]) => { assert.equal(acc.split(now).length, 2, `20 Oct change not found once: ${now.slice(0, 60)}`); return acc.replace(now, before); }, p);
  const undone18 = DECISION_CHANGES_2026_10_18.reduce((acc, [now, before]) => { assert.equal(acc.split(now).length, 2, `18 Oct change not found once: ${now.slice(0, 60)}`); return acc.replace(now, before); }, undone20);
  const undone = DECISION_CHANGES_2026_10_17.reduce((acc, [now, before]) => { assert.ok(acc.includes(now), `decision change not found: ${now.slice(0, 60)}`); return acc.split(now).join(before); }, undone18);
  return RULE_CHANGES_SINCE_SPLIT.reduce((acc, r) => { assert.ok(acc.includes(r), `rule change not found: ${r.slice(0, 60)}`); return acc.replace(r, ''); }, undone);
};

test('the prompt rendered from the seed equals the pre-knowledge-base prompt apart from the listed rule changes and owner decisions (nothing else changed)', () => {
  const p = withoutRuleChanges(renderSystemPrompt(SEED));
  assert.equal(p.length, ORIGINAL_PROMPT_LENGTH);
  assert.equal(crypto.createHash('sha256').update(p).digest('hex'), ORIGINAL_PROMPT_SHA256);
  assert.doesNotMatch(p, /\{\{/, 'no placeholder left');
});

test('every placeholder resolves to text in the seed', () => {
  const paths = templatePaths();
  assert.ok(paths.length >= 38, `${paths.length} facts`);
  for (const path of paths) assert.equal(typeof getPath(SEED, path), 'string', path);
});

test('the rules template itself holds no addresses, prices, links or WiFi passwords', () => {
  const t = SYSTEM_PROMPT_TEMPLATE;
  for (const fact of ['Zhiuli Shartava', 'maps.app.goo.gl', 'maxela03', 'maxela62', '15 GEL', '30 GEL', 'booking.com/Share', '13 24 13#', 'app.maxelaapartments.com', '975338858914982']) {
    assert.ok(!t.includes(fact), `"${fact}" should live in the knowledge base`);
  }
});

test('changing a fact in the knowledge base changes the prompt (and nothing else)', () => {
  const kb = JSON.parse(JSON.stringify(SEED));
  kb.policies.parking.reply.en = 'PARKING TEXT';
  const p = renderSystemPrompt(kb);
  assert.ok(p.includes('then text: PARKING TEXT'));
  assert.equal(p.replace('PARKING TEXT', SEED.policies.parking.reply.en), renderSystemPrompt(SEED));
  delete kb.policies.gym;
  assert.throws(() => renderSystemPrompt(kb), /missing fact "policies.gym.reply.en"/);
});

test('properties and units', () => {
  assert.deepEqual(Object.keys(SEED.properties).sort(), ['abashidze', 'freedom_square', 'orbeliani', 'shartava', 'vgl', 'xcv']);
  for (const [code, prop] of [['6-2', 'shartava'], ['0-3', 'shartava'], ['tab-1', 'freedom_square'], ['orb-2', 'orbeliani'], ['vgl-st1', 'vgl'], ['xcv-2', 'xcv'], ['abashidze', 'abashidze'], ['VGL-AP9', 'vgl']]) {
    assert.equal(propertyIdForRoom(SEED, code), prop, code);
  }
  assert.equal(propertyIdForRoom(SEED, ''), null);
  assert.equal(SEED.units['6-3'].type, 'threeBedroom');
  assert.equal(SEED.properties.shartava.botAnswers, true);
  assert.ok(Object.entries(SEED.properties).filter(([, p]) => p.botAnswers).every(([id]) => id === 'shartava'));
});

test('unitFactLines: the unit\'s own facts, only where the bot answers', () => {
  assert.deepEqual(unitFactLines(SEED, '6-2'), ['This guest\'s unit: 6-2 is a Superior Apartment (has a kitchen), up to 6 guests.'], 'no WiFi without the check-in page data');
  assert.deepEqual(unitFactLines(SEED, '7-1', { name: 'Maxela 7-4', password: 'pw74' }), [
    'This guest\'s unit: 7-1 is a Superior Apartment (has a kitchen), up to 6 guests.',
    'This guest\'s WiFi (from their check-in page, exactly as written): network "Maxela 7-4", password "pw74".',
  ], 'a shared network is given exactly as saved');
  assert.deepEqual(unitFactLines(SEED, '0-4'), ['This guest\'s unit: 0-4 is a Triple Room with Private Bathroom (no kitchen), up to 4 guests.']);
  assert.match(unitFactLines(SEED, '6-3')[0], /3 Bedroom Apartment \(has a kitchen\), up to 11 guests plus 1 baby in the baby bed\.$/);
  assert.deepEqual(unitFactLines(SEED, 'tab-1', { name: 'csofs', password: 'x' }), [], 'Freedom Square: no WiFi either');
  assert.deepEqual(unitFactLines(SEED, 'tab-1'), [], 'Freedom Square: the bot does not answer');
  assert.deepEqual(unitFactLines(SEED, ''), []);
});

test('WiFi has no pattern rule and no copy in the knowledge base (the check-in page data is the only source)', () => {
  const p = renderSystemPrompt(SEED);
  assert.doesNotMatch(p, /maxela03|maxela62|"maxela \[unit\]"|explain the pattern/);
  for (const [code, unit] of Object.entries(SEED.units)) assert.equal(unit.wifi, undefined, code);
  assert.match(p, /never work a name or password out from the unit number/);
});

test('owner decisions: address, parking, capacity, refund, new booking, unknown location', () => {
  const p = renderSystemPrompt(SEED);
  assert.equal(SEED.properties.shartava.mapsUrl, 'https://maps.app.goo.gl/fSW3iLsu4MxghzGRA');
  assert.ok(SEED.properties.shartava.addressLine.includes(SEED.properties.shartava.mapsUrl));
  assert.equal(SEED.policies.parking.mapsUrl, 'https://maps.app.goo.gl/MruPY7q5RB1trNCz9');
  assert.ok(SEED.policies.parking.reply.en.endsWith(SEED.policies.parking.mapsUrl));
  assert.doesNotMatch(p, /g1wVvjEG3xRn5bNR7|LArVmJASytmQdReJA/, 'old links gone');
  assert.equal(SEED.unitTypes.threeBedroom.maxGuests, 11);
  assert.equal(SEED.unitTypes.threeBedroom.maxBabies, 1);
  assert.doesNotMatch(p.match(/ANGRY GUEST DETECTION:\n[^\n]*/)[0], /refund/);
  assert.match(p, /Refund request[^\n]*\nReply: Let me check on that and get back to you shortly\. \[ESCALATE\]/);
  assert.match(p, /New bookings can take up to 10 minutes to appear in our system\. Please try the check-in page again in about 10 minutes\./);
  assert.match(p, /Never assume the guest is staying at Shartava/);
  assert.match(p, /Never ask the guest which location or property they are staying at/);
  assert.deepEqual(SEED.policies.cleaning.prices, { en: 'Room 30 GEL, Apartment 50 GEL, 3 Bedroom Apartment 70 GEL.', room: 30, apartment: 50, threeBedroom: 70, currency: 'GEL' });
});

test('no door or smart lock code anywhere in the knowledge base except the bag storage code', () => {
  const json = JSON.stringify(SEED);
  assert.ok(!/"(doorCode|tuyaDeviceId)"/.test(json), 'no doorCode / tuyaDeviceId fields');
  const codes = json.match(/\b\d{2} \d{2} \d{2}#/g) || [];
  assert.ok(codes.every((c) => c === '13 24 13#'), codes.join(','));
});

/** A minimal read-only Firestore fake: { collection: { docId: data } }. */
function fakeDb(data, { fail = false } = {}) {
  return {
    collection: (name) => ({
      get: async () => {
        if (fail) throw new Error('unavailable');
        const docs = Object.entries(data[name] || {}).map(([id, d]) => ({ id, data: () => d }));
        return { empty: docs.length === 0, docs };
      },
    }),
  };
}

test('readKnowledgeBase: Firestore docs override the seed by id; door codes never copied', async () => {
  const kb = await readKnowledgeBase(fakeDb({
    kb_policies: { parking: { pricePerDay: 20, reply: { en: 'NEW PARKING' } } },
    kb_units: { '6-2': { displayName: 'Apt 6-2', doorCode: '9999' } },
  }));
  assert.equal(kb.policies.parking.pricePerDay, 20);
  assert.equal(kb.policies.parking.reply.en, 'NEW PARKING');
  assert.equal(kb.policies.parking.mediaId, SEED.policies.parking.mediaId, 'rest of the entry kept');
  assert.equal(kb.units['6-2'].displayName, 'Apt 6-2');
  assert.equal(kb.units['6-2'].type, 'superior', 'rest of the unit kept');
  assert.equal(kb.units['6-2'].doorCode, undefined);
  assert.equal(SEED.policies.parking.pricePerDay, 15, 'seed itself untouched');
});

test('loadKnowledgeBase: empty Firestore -> seed; errors or a broken edit -> seed; cached', async () => {
  const quiet = { warn: () => {} };
  resetKnowledgeBaseCache();
  assert.equal(renderSystemPrompt(await loadKnowledgeBase(fakeDb({}), { nowMs: 1, log: quiet })), renderSystemPrompt(SEED));
  resetKnowledgeBaseCache();
  assert.equal(await loadKnowledgeBase(fakeDb({}, { fail: true }), { nowMs: 1, log: quiet }), SEED);
  resetKnowledgeBaseCache();
  const broken = await loadKnowledgeBase(fakeDb({ kb_policies: { gym: { reply: null } } }), { nowMs: 1, log: quiet });
  assert.equal(renderSystemPrompt(broken), renderSystemPrompt(SEED), 'a doc that removes a fact falls back to the seed');
  resetKnowledgeBaseCache();
  const a = await loadKnowledgeBase(fakeDb({ kb_policies: { gym: { reply: { en: 'GYM A' } } } }), { nowMs: 1000, log: quiet });
  const b = await loadKnowledgeBase(fakeDb({ kb_policies: { gym: { reply: { en: 'GYM B' } } } }), { nowMs: 2000, log: quiet });
  assert.equal(b, a, 'cached for 5 minutes');
  resetKnowledgeBaseCache();
});

test('loadUnitWifi: only wifiName / wifiPass of that unit, null when unknown or failing', async () => {
  const calls = [];
  const db = (docs, { fail = false } = {}) => ({
    collection: (name) => ({
      doc: (id) => ({ id }),
      where: (field, op, ref) => ({
        select: (...fields) => ({
          get: async () => {
            calls.push({ name, id: ref.id, fields });
            if (fail) throw new Error('unavailable');
            const d = docs[ref.id];
            return d ? { empty: false, docs: [{ get: (f) => d[f] }] } : { empty: true, docs: [] };
          },
        }),
      }),
    }),
  });
  const quiet = { warn: () => {} };
  const data = { '7-1': { wifiName: 'Maxela 7-4', wifiPass: 'pw74' }, abashidze: { wifiName: '', wifiPass: '' } };
  assert.deepEqual(await loadUnitWifi(db(data), '7-1'), { name: 'Maxela 7-4', password: 'pw74' });
  assert.deepEqual(calls[0], { name: 'checkin_apartments', id: '7-1', fields: ['wifiName', 'wifiPass'] }, 'never selects door codes');
  assert.equal(await loadUnitWifi(db(data), 'abashidze'), null, 'nothing saved');
  assert.equal(await loadUnitWifi(db(data), '9-9'), null, 'no such unit');
  assert.equal(await loadUnitWifi(db(data), ''), null);
  assert.equal(await loadUnitWifi(db(data, { fail: true }), '7-1', { log: quiet }), null);
});

test('18 Oct: room type tone and parking behind the building', () => {
  const p = renderSystemPrompt(SEED);
  assert.doesNotMatch(p, /If you have questions about your booking please contact Booking\.com|as shown in the listing\. We also have/);
  assert.match(p, /never tell them to contact Booking\.com or Expedia/);
  assert.equal(SEED.unitTypes.superior.layout.en, 'It has two rooms in total: a separate bedroom with a double bed, and a second double bed in the living room, divided by curtains. It has a kitchen and fits up to 6 guests.');
  assert.ok(p.includes(SEED.unitTypes.superior.layout.en));
  const pb = SEED.policies.parking.behindBuilding;
  for (const t of [pb.reply.en, pb.reply.ka, pb.insist.en, pb.insist.ka]) assert.ok(p.includes(t), t.slice(0, 40));
  assert.match(pb.insist.en, /about 30 spaces there for around 400 families/);
  assert.match(p, /Reservations are only through Booking\.com or Expedia/, 'new bookings keep Booking.com');
});

test('20 Oct: Georgian refund reply in Georgian; payment questions go to the owner', () => {
  const p = renderSystemPrompt(SEED);
  assert.match(p, /Refund request[^\n]*\nReply: Let me check on that and get back to you shortly\. \[ESCALATE\]\nWhen the guest wrote in Georgian, the whole reply is in Georgian, never English: Reply exactly: შევამოწმებ და მალე მოგწერთ\. \[ESCALATE\]/);
  assert.match(p, /asks how or when to pay[^\n]*\nReply: Let me check on that and get back to you shortly\. \[ESCALATE\]/);
  assert.match(p, /Never explain payment methods yourself/);
});
