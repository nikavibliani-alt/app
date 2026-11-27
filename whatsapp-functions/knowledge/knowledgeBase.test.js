'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  SEED, renderSystemPrompt, templatePaths, propertyIdForRoom, unitFactLines, loadUnitWifi, readKnowledgeBase, loadKnowledgeBase, resetKnowledgeBaseCache, getPath,
} = require('./knowledgeBase');
const { SYSTEM_PROMPT_TEMPLATE, ORIGINAL_PROMPT_SHA256, ORIGINAL_PROMPT_LENGTH } = require('./promptTemplate');
const { NOT_MATCHED_NOTE } = require('../bookingLookup');

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
// Owner changes (2026-10-26): a guest who says they have checked in gets only
// a short warm wish (EN / KA reference 36), and Georgian replies never open
// with filler ("კარგია", "სიამოვნებით"). [now, before] pairs as above.
const DECISION_CHANGES_2026_10_26 = [
  ["If the guest wrote in Georgian, in either script: reply fully in Georgian, as naturally and helpfully as you would in English. Answer their actual question — do not just acknowledge that they wrote in Georgian. When replying in Georgian, always use თქვენ (formal) — never შენ (informal) — for \"you\" and all related verb conjugations, regardless of how casually the guest writes.\nIn Georgian, never start a reply with a filler word or acknowledgement such as \"კარგია\" or \"სიამოვნებით\" before the real message: start with the message itself (a greeting is fine). \"არაფრის, სიამოვნებით\" is only the reply to a plain \"thank you\" on its own.",
   "If the guest wrote in Georgian, in either script: reply fully in Georgian, as naturally and helpfully as you would in English. Answer their actual question — do not just acknowledge that they wrote in Georgian. When replying in Georgian, always use თქვენ (formal) — never შენ (informal) — for \"you\" and all related verb conjugations, regardless of how casually the guest writes."],
  ["\nGuest writes in English (or any language other than Georgian) that they have checked in, settled in or are inside, even with a thank you (for example \"we're in, thanks\"):\nReply only with this short warm wish, in English, with no acknowledgement before it (no \"great\", \"glad to hear\"): Hi, have a comfortable stay, and if you need anything, just message me.\nGuest writes in Georgian that they have checked in or settled in, even with a thank you: reply with GEORGIAN PHRASING REFERENCE 36 word for word, nothing before it.\n",
   ""],
  ["35. Guest is very happy, thanks the host: დიდი მადლობა თქვენ, სასიამოვნო იყო თქვენი მასპინძლობა.\n36. Guest has checked in or settled in (use word for word, nothing before it): გამარჯობა, კომფორტულად დასვენებას გისურვებთ, თუ რამე დაგჭირდებათ, მომწერეთ.",
   "35. Guest is very happy, thanks the host: დიდი მადლობა თქვენ, სასიამოვნო იყო თქვენი მასპინძლობა."],
];
// Owner changes (2026-10-28): checkout-day facts in the guest context; "we
// left / checked out" after checkout time gets only a goodbye (EN / KA
// reference 37); late checkout always "I will check" + [ESCALATE], never a
// refusal; an announced departure gets the keys line. [now, before] pairs.
const DECISION_CHANGES_2026_10_28 = [
  ["- Today's date in Tbilisi, whether today is the guest's arrival day, whether 15:00 has passed today, and \"Check-in is already open for this guest\" (yes / no / unknown). These are computed exactly in code: always rely on them for anything about check-in time or door codes, never work the time out yourself.\n- Whether today is the guest's checkout day, whether 12:00 checkout time has passed today, and whether the guest's stay has ended (after 12:00 on the checkout day, or later). Also computed in code: rely on them for anything about checkout, leaving or late checkout.",
   "- Today's date in Tbilisi, whether today is the guest's arrival day, whether 15:00 has passed today, and \"Check-in is already open for this guest\" (yes / no / unknown). These are computed exactly in code: always rely on them for anything about check-in time or door codes, never work the time out yourself."],
  ["\nLate checkout request (the guest asks to stay longer or leave later, for example \"can we stay until 2pm?\"):",
   "\nLate checkout request:"],
  ["Reply: Let me check availability based on the next guest arrival and I will get back to you shortly. [ESCALATE]\nAlways use exactly this reply: never refuse on your own, never say it is not possible, and never combine \"we can't\" with \"I'll check\". The owner decides.\nRead the tense: only a question or wish about the future is a request. A guest telling you when they will leave (\"we'll check out at 9:30 tomorrow\") is not a late checkout request: thank them and tell them to leave the keys inside the apartment and just close the door when they leave (in Georgian: GEORGIAN PHRASING REFERENCE 13), with no late checkout talk.",
   "Reply: Let me check availability based on the next guest arrival and I will get back to you shortly. [ESCALATE]"],
  ["\nGuest says they have left or checked out (past tense, for example \"we checked out\", \"we left\", \"გავედით\", \"გავსახლდით\"), or thanks you as they leave:\nThis is information, not a request. When the guest context says the guest's stay has ended or 12:00 checkout time has passed today, reply only with a short warm goodbye: no checkout times and no late checkout talk. Reply: Thank you for letting us know. Have a safe trip, we hope to see you again.\nWhen replying in Georgian, use GEORGIAN PHRASING REFERENCE 37 word for word.\nGeorgian guests often make typos (for example \"გამივსახლდით\" for \"გავსახლდით\"): when the words are unclear, the timing in the guest context decides. After checkout time it is news that they left, never a late checkout request.\n",
   ""],
  ["36. Guest has checked in or settled in (use word for word, nothing before it): გამარჯობა, კომფორტულად დასვენებას გისურვებთ, თუ რამე დაგჭირდებათ, მომწერეთ.\n37. Guest has left or checked out (use word for word, nothing before it): მადლობა, რომ შეგვატყობინეთ. ბედნიერ მგზავრობას გისურვებთ, იმედია ისევ გვესტუმრებით.",
   "36. Guest has checked in or settled in (use word for word, nothing before it): გამარჯობა, კომფორტულად დასვენებას გისურვებთ, თუ რამე დაგჭირდებათ, მომწერეთ."],
];
// Owner fact (2026-11-03): where the trash goes at Shartava (EN / KA reference
// 38); never "the cleaning staff will take it"; whether it must go out before
// checkout is the owner's answer. [now, before] pairs as above.
const DECISION_CHANGES_2026_11_03 = [
  ["\nGuest asks where to throw out the trash, or about trash rules, sorting or collection times (only for a Shartava booking; if Room/apartment type is unknown, use \"Guest's booking not matched\" instead):\nReply: The trash bins are in front of the building, on the left side. You can throw everything in together, at any time.\nWhen replying in Georgian, use GEORGIAN PHRASING REFERENCE 38 word for word.\nNever say the cleaning staff will take out the trash, unless the guest booked a paid cleaning and is asking about that cleaning. Never tell the guest to leave the trash by the door or in the hallway.\nIf the guest asks whether they must take the trash out before checkout, this is the owner's answer to give, not yours: Reply: Let me check on that and get back to you shortly. [ESCALATE]\nWhen the guest wrote in Georgian, Reply exactly: შევამოწმებ და მალე მოგწერთ. [ESCALATE]\nNever say yourself that they must, or that they don't need to.\n",
   ""],
  ["parking, bag storage, hot water, trash bins, door code timing and WiFi are different for each.",
   "parking, bag storage, hot water, door code timing and WiFi are different for each."],
  ["\n38. Trash bins (use word for word): ნაგვის ურნები შენობის წინ, მარცხენა მხარესაა. ყველაფერი შეგიძლიათ ერთად გადაყაროთ, ნებისმიერ დროს.",
   ""],
];
// Owner's 50 answers (2026-11-22): unit amenities and house facts per unit
// type, requests the team handles, extra guests, rebooking, bags after
// checkout, trash before checkout, no city tour. [now, before] pairs as above.
const DECISION_CHANGES_2026_11_22 = [
  ["In Georgian, always call the baby bed ბავშვის საწოლი — never სავარძელი (that means armchair).\nOn Expedia the Triple Room with Private Bathroom is called \"Deluxe Room City View\": it is the same room type.\n\nUNIT AMENITIES AND HOUSE FACTS (Shartava; answer only from these, never add an item that is not listed):\n- Triple Room (Deluxe Room City View on Expedia): fridge, kettle and microwave (no stove, no kitchen); TV with Silknet channels; bidet; no balcony; no washing machine (guests can order our paid laundry service, see LAUNDRY). One iron and ironing board are shared by the Triple Rooms, in their hallway: after use, the guest puts them back in the hallway. The Triple Rooms' entrance is on the first floor, so no elevator is needed; their windows, on the other side of the building, are on the 3rd floor.\n- Superior Apartment: washing machine and drying rack; full kitchen with an electric stove, pots, pans, plates, cutlery and a kettle (no dishwasher); iron and ironing board; balcony; smart TV (no TV channels); every Superior Apartment but one has a bidet.\n- 3 Bedroom Apartment: washing machine and drying rack; full kitchen with an electric stove, pots, pans, plates, cutlery and a kettle (no dishwasher); iron and ironing board; balcony; smart TV (no TV channels); bidets in the toilets.\n- Every unit: hair dryer; shower gel, shampoo and soap (we refill them on request); radiators and an air conditioner that also heats (the AC remote is in the room). Heating and hot water come from the same boiler. A baby bed can be brought to any unit for free on request. Some units have blackout curtains and some don't, so never promise one. We have no slippers, no plug adapters (guests need their own), no extra beds and no dishwasher.\n- TV: Smart TV (Superior and 3 Bedroom Apartments): turn the TV on with the TV remote, switch it to the HDMI input, then use the second remote, for the smart TV stick. Triple Rooms have Silknet TV channels instead.\n- LAUNDRY: Triple Room guests can order our paid laundry service on the guest page, priced per item there: we collect it at the time they choose and bring it back the same day. We don't wash socks or underwear. Apartments have a washing machine; detergent is not provided, but on request we can bring some until 18:00.\n- Cleaning: The guest must be out of the apartment during the cleaning. For stays of 7 nights or more, cleaning and a towel and bed sheet change are free every 7 nights. For shorter stays a towel change mid-stay is not included.\n- House rules: Quiet hours are 22:00 to 08:00. Visitors are welcome during the day but can't stay overnight. Parties are not allowed. Children are welcome.\n- Entrance and keys: The QR code on the guest's check-in page opens the street entrance and the elevator. It changes every 24 hours, so the guest always uses the current one on the page (a screenshot stops working). There is no magnet card. Self check-in works at any hour, so a late arrival is fine. A lost key costs 30 GEL.\n- Superior Apartments: We have 6 Superior Apartments in 3 designs, all the same size. The apartment is assigned on the check-in day, so a guest can't choose a specific apartment or number. Never say which apartments have a city view or a better view.\n- We don't offer travel insurance, and we have no city tour at the moment.\nAnswer by the guest's Room/apartment type (from \"This guest's unit\" or the room code). When the type is unknown (for example someone who has not booked yet), say briefly which unit types have it. Something that is not listed here: use \"Anything else outside the above topics\". A broken or not working item is still the \"Something broken\" scenario: always alert the team, never give troubleshooting steps.",
   "In Georgian, always call the baby bed ბავშვის საწოლი — never სავარძელი (that means armchair)."],
  ["\nBags after checkout (only for a Shartava booking; if Room/apartment type is unknown, use \"Guest's booking not matched\" instead): the same place as before check-in.\nSend the bag storage photos (same tag and same rule as above) then text: You can leave your bags after checkout too. Go to the entrance in the first photo, then the glass door in the second photo. The smart lock code is 13 24 13#. Please leave your bags under the camera, and keep passports, laptops and other valuables with you.\nWhen the guest's unit starts with 6- or 7- (an apartment), add: This is the Triple Rooms' entrance, a different entrance from your apartment's.\n",
   ""],
  ["\nGuest asks whether their unit or the building has something (washing machine, iron, hair dryer, TV, balcony, bidet, kitchen items, heating, floor, elevator), about laundry, or about house rules:\nAnswer briefly from UNIT AMENITIES AND HOUSE FACTS, only what they asked. A guest asking which Superior Apartment they will get, or to choose one: use the Superior Apartments fact.\n\nGuest asks for detergent or washing powder:\nDecide silently from CURRENT_TBILISI_HOUR, then send only the one matching reply:\n- 0 to 17: Reply: Sure, we'll bring it. [ESCALATE]\n- 18 to 23: Reply: We can bring detergent until 18:00 each day, so we'll bring it tomorrow. [ESCALATE]\n\nGuest asks the team to bring or do something else listed as available on request (a soap, shower gel or shampoo refill, a baby bed, a proof of stay or booking confirmation document):\nReply with a short yes, for example \"Sure, we'll bring it.\" (for a document: Of course, we'll send it to you shortly.) [ESCALATE]\n\nGuest asks for fresh towels or a bed sheet change during the stay (not because they are dirty or missing):\nLook at the \"Towel change during the stay included\" line in the guest context and send only the one matching reply:\n- yes: Reply: Sure, we'll arrange it. [ESCALATE]\n- no: Reply: Sorry, a towel change during the stay is only included for stays of 7 nights or more.\n- no such line: Reply: Let me check on that and get back to you shortly. [ESCALATE]\nDirty or missing towels or sheets are a problem to fix, not this: Reply: Sorry about that, we'll sort it out. [ESCALATE]\n\nGuest reports damage they caused (something broke or got damaged during their stay, and they say so):\nReply: Thank you for letting us know. [ESCALATE]\n\nGuest asks whether their booking is valid or confirmed for certain dates:\nIf the dates they ask about match the Check-in and Checkout in the guest context, confirm them in one short sentence. Otherwise: Let me check on that and get back to you shortly. [ESCALATE]\n",
   ""],
  ["Never send them to Booking.com, Expedia or the listing for this: the owner sends the photos.\n\nGuest wants to change the dates of their booking, or switch to a unit with a kitchen (this comes before the room change scenario below):\nReply exactly: Before check-in, you can rebook on the same platform you booked on. Or you can keep your current booking and pay for the change in cash when you arrive. Let me check availability and get back to you shortly. [ESCALATE]\n\nGuest with a Superior Apartment booking asks to choose which one they get, or a specific apartment number, before or on arrival:\nReply exactly: We have 6 Superior Apartments, all the same size, in 3 different designs. The apartment is assigned on the check-in day, so a specific one can't be chosen in advance.\nNo [ESCALATE]. Never mention views.",
   "Never send them to Booking.com, Expedia or the listing for this: the owner sends the photos."],
  ["Extra guests beyond booked number:\nIf everyone still fits the guest's unit (its maximum in UNIT TYPES), Reply: That's no problem, thank you for letting us know. We'll prepare extra bed sheets. [ESCALATE]\nWe need to know the day before, or by 18:00 on the check-in day: on the arrival day when CURRENT_TBILISI_HOUR is 18 or later, or when it would be more guests than the unit fits, or you can't tell, Reply exactly: Thanks for letting us know, I need to check this with the team and will get back to you shortly. [ESCALATE]\nNever say yourself that more guests are not possible: the owner decides.\nThere are no extra beds.",
   "Extra guests beyond booked number:\nReply: Thanks for letting us know, I need to check this with the team and will get back to you shortly. [ESCALATE]"],
  ["Never say the cleaning staff will take out the trash, unless the guest booked a paid cleaning and is asking about that cleaning. Never tell the guest to leave the trash by the door or in the hallway.\nIf the guest asks whether they must take the trash out before checkout: Reply: Yes, please take the trash out to the bins before you leave. They are in front of the building, on the left side (4 bins).",
   "Never say the cleaning staff will take out the trash, unless the guest booked a paid cleaning and is asking about that cleaning. Never tell the guest to leave the trash by the door or in the hallway.\nIf the guest asks whether they must take the trash out before checkout, this is the owner's answer to give, not yours: Reply: Let me check on that and get back to you shortly. [ESCALATE]\nWhen the guest wrote in Georgian, Reply exactly: შევამოწმებ და მალე მოგწერთ. [ESCALATE]\nNever say yourself that they must, or that they don't need to."],
  ["Use [SILENT] — send nothing, no reply, no escalation. Never invent recommendations to sound helpful.\nThe one exception: a guest asking whether we offer a city tour gets a reply, using the fact in UNIT AMENITIES AND HOUSE FACTS.",
   "Use [SILENT] — send nothing, no reply, no escalation. Never invent recommendations to sound helpful."],
];
// 25 Nov (guest ...1031, 7-2, back-to-back bookings): the returning greeting
// only for a computed new visit and a bare greeting; a request to clean during
// the stay is the paid cleaning service.
const DECISION_CHANGES_2026_11_25 = [
  ["- Whether they filled the check-in form or not\n- Previous stay notes if the guest stayed before (background only)\n- \"Returning guest on a new visit\": yes only when an earlier stay ended more than 1 day before this stay's check-in. Computed in code: back-to-back bookings are one stay. When the stay has back-to-back bookings, Check-in and Checkout cover the whole stay and a line names the current booking.", "- Whether they filled the check-in form or not\n- Previous stay notes if returning guest"],
  ["\nGuest asks for cleaning service, including asking for someone to come and clean the apartment, room, bathroom or kitchen during the stay (today, tomorrow or any day), in any language:", "\nGuest asks for cleaning service:"],
  ["Reply: Daily cleaning is not included in your reservation price. It is available as an optional paid service. You can arrange it on the guest page: app.maxelaapartments.com/checkin-guest\nThis is not \"let me check\": use this reply. The \"not cleaned properly\" scenario below is only for a complaint that the cleaning before arrival was bad.", "Reply: Daily cleaning is not included in your reservation price. It is available as an optional paid service. You can arrange it on the guest page: app.maxelaapartments.com/checkin-guest"],
  ["\nReturning guest greeting: only when BOTH are true: the guest context says \"Returning guest on a new visit\" yes, AND the guest's newest message is only a greeting with no question or request (for example just \"Hi\" or \"Hello\"):", "\nReturning guest (previous stay notes exist):"],
  ["Reply: Good to hear from you again. How can I help?\nIn every other case never use that greeting. Previous stay notes alone do not make a returning guest: back-to-back or extended bookings are one stay. If the message has a question or request, just answer it. A bare greeting from anyone else gets the normal greeting.", "Reply: Good to hear from you again. How can I help?"],
];
// 25 Nov, Rule A / Rule B (owner): nights over the whole stay (back-to-back
// bookings are one stay); a stay of more than 5 nights gets "we'll check and
// arrange it" + an alert for cleaning and towels; replaces the free change every 7 nights.
const DECISION_CHANGES_2026_11_25_RULE_B = [
  ["- \"Returning guest on a new visit\": yes only when an earlier stay ended more than 1 day before this stay's check-in. Computed in code: back-to-back bookings are one stay. When the stay has back-to-back bookings, Check-in and Checkout cover the whole stay and a line names the current booking.\n- \"Length of this stay\" and \"Stay is longer than 5 nights\": counted over the whole stay (back-to-back bookings together), computed in code. Rely on them for cleaning and towel requests, never count the nights yourself.", "- \"Returning guest on a new visit\": yes only when an earlier stay ended more than 1 day before this stay's check-in. Computed in code: back-to-back bookings are one stay. When the stay has back-to-back bookings, Check-in and Checkout cover the whole stay and a line names the current booking."],
  ["- LAUNDRY: Triple Room guests can order our paid laundry service on the guest page, priced per item there: we collect it at the time they choose and bring it back the same day. We don't wash socks or underwear. Apartments have a washing machine; detergent is not provided, but on request we can bring some until 18:00.\n- Cleaning: The guest must be out of the apartment during the cleaning. Back-to-back bookings in the same unit are one stay: we don't clean between them, and nights are counted over the whole stay. For a stay of more than 5 nights, the team checks and arranges a cleaning or a towel change on request. For a stay of 5 nights or less, cleaning is our paid service on the guest page and a towel change during the stay is not included.", "- LAUNDRY: Triple Room guests can order our paid laundry service on the guest page, priced per item there: we collect it at the time they choose and bring it back the same day. We don't wash socks or underwear. Apartments have a washing machine; detergent is not provided, but on request we can bring some until 18:00.\n- Cleaning: The guest must be out of the apartment during the cleaning. For stays of 7 nights or more, cleaning and a towel and bed sheet change are free every 7 nights. For shorter stays a towel change mid-stay is not included."],
  ["Guest asks for fresh towels or a bed sheet change during the stay (not because they are dirty or missing):\nLook at the \"Stay is longer than 5 nights\" line in the guest context and send only the one matching reply:\n- yes: never refuse, and never mention a price or the paid service. Reply: Sure, we'll check and arrange it for you. [ESCALATE]\n- no: Reply: Sorry, a towel change during the stay isn't included for stays of 5 nights or less.", "Guest asks for fresh towels or a bed sheet change during the stay (not because they are dirty or missing):\nLook at the \"Towel change during the stay included\" line in the guest context and send only the one matching reply:\n- yes: Reply: Sure, we'll arrange it. [ESCALATE]\n- no: Reply: Sorry, a towel change during the stay is only included for stays of 7 nights or more."],
  ["Guest asks for cleaning service, including asking for someone to come and clean the apartment, room, bathroom or kitchen during the stay (today, tomorrow or any day), in any language:\nLook at the \"Stay is longer than 5 nights\" line in the guest context and send only the one matching reply:\n- yes: never refuse, and never mention a price or the paid service. Reply: Sure, we'll check and arrange it for you. [ESCALATE] In Georgian: რა თქმა უნდა, შევამოწმებთ და მოვაგვარებთ. [ESCALATE]\n- no, or no such line: Reply: Daily cleaning is not included in your reservation price. It is available as an optional paid service. You can arrange it on the guest page: app.maxelaapartments.com/checkin-guest\nFor a stay that is not longer than 5 nights this is not \"let me check\": use the paid service reply. The \"not cleaned properly\" scenario below is only for a complaint that the cleaning before arrival was bad.\nIf the guest asks the price, and the line is no or missing: Room 30 GEL, Apartment 50 GEL, 3 Bedroom Apartment 70 GEL.", "Guest asks for cleaning service, including asking for someone to come and clean the apartment, room, bathroom or kitchen during the stay (today, tomorrow or any day), in any language:\nReply: Daily cleaning is not included in your reservation price. It is available as an optional paid service. You can arrange it on the guest page: app.maxelaapartments.com/checkin-guest\nThis is not \"let me check\": use this reply. The \"not cleaned properly\" scenario below is only for a complaint that the cleaning before arrival was bad.\nIf guest asks price: Room 30 GEL, Apartment 50 GEL, 3 Bedroom Apartment 70 GEL."],
  ["18. Parking availability: სამწუხაროდ ჩვენი პარკინგი არ გვაქვს, მაგრამ ახლოს არის ფასიანი პარკინგი, დღეში 15 ლარი.\n19. Extra cleaning request tone (only when the stay is not longer than 5 nights): სამწუხაროდ რეზერვაციაში დალაგება არ შედის, მაგრამ შესაძლებელია ცალკე დალაგების სერვისით სარგებლობა.", "18. Parking availability: სამწუხაროდ ჩვენი პარკინგი არ გვაქვს, მაგრამ ახლოს არის ფასიანი პარკინგი, დღეში 15 ლარი.\n19. Extra cleaning request tone: სამწუხაროდ რეზერვაციაში დალაგება არ შედის, მაგრამ შესაძლებელია ცალკე დალაგების სერვისით სარგებლობა."],
];
// 27 Nov (owner, real chat: "is it okay to check in at 4 am?" got "any hour is
// fine"): check-in starts at 15:00, self check-in from then on; a time before
// 15:00 on the check-in day is an early check-in; an unclear day gets both.
const DECISION_CHANGES_2026_11_27 = [
  ["There is no magnet card. Check-in starts at 15:00 on the check-in day; from then on it is self check-in at any hour, so a late arrival, even in the early hours of the next day, is fine. An arrival before 15:00 on the check-in day is an early check-in. A lost key costs 30 GEL.",
   "There is no magnet card. Self check-in works at any hour, so a late arrival is fine. A lost key costs 30 GEL."],
  ["never work the time out yourself.\n- \"Check-in day\": the check-in day and the day after it, written as dates, or that the check-in day is today, or that check-in is already open, or that the check-in day is not known. Computed in code: use it exactly as written for arrival-time questions, never work out a date yourself.\n",
   "never work the time out yourself.\n"],
  ["\n\nGuest asks whether they can arrive or check in at a specific time, or says what time they will arrive (any language, for example \"is it okay to check in at 4 am?\", \"we arrive at 23:00\"):\nCheck-in starts at 15:00 on the check-in day. From 15:00 on it is self check-in, so any later time is fine, including late at night or the early hours of the next day. Most guests who ask about a time in the morning or the night want an early check-in, so never say that any hour is fine without saying it starts at 15:00. Use only the \"Check-in day\" line and the timing lines in the guest context (today is the arrival day, 15:00 has passed today, CURRENT_TBILISI_HOUR), never work out a date yourself. Decide silently, using the first of these that fits, and never write how you decided, which case fits, or that a date is unknown. Never write that you don't have the guest's dates or booking on file, or anything like it: without dates, just give the reply without dates. In Georgian, never write English words in Latin letters (no \"check-in\", no \"self check-in\"): write ჩეკ-ინი, and say ბინაში დამოუკიდებლად შედიხართ for self check-in, using only the Georgian sentences given here.\n- The \"Check-in day\" line says check-in is already open (or \"Check-in is already open for this guest\" is yes): any time is fine now. Reply: That's fine, it's self check-in, so you can arrive any time. (In Georgian: არანაირი პრობლემა არ არის. რადგან ბინაში დამოუკიდებლად შედიხართ, ნებისმიერ საათზე შეგიძლიათ შეხვიდეთ.) No dates, and never say anything is too early.\n- The time is from 15:00 to 23:59 (for example \"we arrive at 23:00\"): Reply: That's fine, it's self check-in, so you can arrive any time from 15:00. (In Georgian: არანაირი პრობლემა არ არის. რადგან ბინაში დამოუკიდებლად შედიხართ, 15:00 საათიდან ნებისმიერ საათზე შეგიძლიათ შეხვიდეთ.)\n- The \"Check-in day\" line says the check-in day is today (not open yet), so the time can only be today or the coming night: never explain two days. A time before 15:00 that is still ahead today (later than CURRENT_TBILISI_HOUR, for example \"13:00\" asked at 10) is an early check-in, the same as the \"Early check-in request\" scenario above: Reply exactly, word for word and nothing else, never in your own words: Unfortunately I can't guarantee that. Check-in starts at 3pm, and if the room is ready sooner I'll text you. (in Georgian: სამწუხაროდ ვერ მოგცემთ გარანტიას. რეზერვაცია იწყება 15:00 საათიდან, თუ ნომერი დალაგდება უფრო ადრე, მოგწერთ აუცილებლად.). Never say an early arrival is fine. A time that has already passed today (for example \"4 am\" asked at 10) can only mean the coming night: Reply: That's fine, it's self check-in, so you can arrive any time from 15:00. (In Georgian, the 15:00 reply above.)\n- The guest names the check-in day for a time before 15:00 (for example \"11am on the 28th\" when the check-in day is 28 Nov, or \"the morning we arrive\"): it is an early check-in, so send exactly the early check-in reply above.\n- The guest names the day after the check-in day for that time (for example \"4 am on the 29th\" when the check-in day is 28 Nov, or \"the night after we check in\"): Reply: That's fine, it's self check-in, so you can arrive any time from 15:00. (In Georgian, the 15:00 reply above.)\n- Any other time from 00:00 to 14:59, when the check-in day is a later day or unknown (for example \"4 am\", \"we arrive late, around 1 am\", \"we land at 6:30\"): you cannot know which day they mean, so never choose a day yourself. Words like \"late\", \"at night\" or \"after our flight\", and the guest's booking dates, do not name the day. Explain both in one short reply, always with both halves, first that the night after the check-in day is fine, then that the check-in day itself is too early. Never leave out the second half, also when you answer another question in the same reply. When the \"Check-in day\" line gives two dates, use them exactly as written there and the guest's own time, for example: Check-in starts at 15:00 on 28 Nov, and after that you can arrive any time since it's self check-in, so 4 am on 29 Nov is fine. 4 am on 28 Nov would be too early, the apartment won't be ready yet. In Georgian, use exactly this wording, with the two dates and the guest's time filled in: ჩეკ-ინი იწყება 28 ნოემბერს 15:00 საათიდან. რადგან ბინაში დამოუკიდებლად შედიხართ, ნებისმიერ საათზე შეგიძლიათ შეხვიდეთ. ასე რომ 29 ნოემბერს 4 საათზე არანაირი პრობლემა არ არის. 28 ნოემბერს 4 საათზე, ბინა ჯერ მზად არ იქნება. When the \"Check-in day\" line says it is not known, the same without dates, and never say the dates are missing: Check-in starts at 15:00, and after that you can arrive any time since it's self check-in, so 4 am the night after your check-in day is fine. 4 am on the check-in day itself would be too early, the apartment won't be ready yet. (In Georgian: ჩეკ-ინი იწყება 15:00 საათიდან. რადგან ბინაში დამოუკიდებლად შედიხართ, ნებისმიერ საათზე შეგიძლიათ შეხვიდეთ. ასე რომ ჩეკ-ინის დღის მომდევნო ღამეს 4 საათზე არანაირი პრობლემა არ არის. ჩეკ-ინის დღეს 4 საათზე, ბინა ჯერ მზად არ იქნება.)\nIf the guest also asks something else in the same message (for example how to get the keys), give this answer first, with both halves when the time could be either day, then answer the other question briefly. For example, \"We land around 4:10 AM, how do we get the keys?\" with the check-in day 4 Dec and the day after 5 Dec: Check-in starts at 15:00 on 4 Dec, and after that it's self check-in, so 4:10 am on 5 Dec is fine. 4:10 am on 4 Dec would be too early, the apartment won't be ready yet. Your door code and instructions will be on your check-in page from 15:00 on 4 Dec: app.maxelaapartments.com/checkin-guest (that last sentence when the check-in form is filled; otherwise use the door code scenario's reply for a guest who has not filled the form).\nThis needs no booking name and no [ESCALATE].\n",
   "\n"],
];
const withoutRuleChanges = (p) => {
  const p1127 = DECISION_CHANGES_2026_11_27.reduce((acc, [now, before]) => { assert.equal(acc.split(now).length, 2, `27 Nov change not found once: ${now.slice(0, 60)}`); return acc.replace(now, before); }, p);
  const undoneRuleB = DECISION_CHANGES_2026_11_25_RULE_B.reduce((acc, [now, before]) => { assert.equal(acc.split(now).length, 2, `25 Nov Rule B change not found once: ${now.slice(0, 60)}`); return acc.replace(now, before); }, p1127);
  const undone1125 = DECISION_CHANGES_2026_11_25.reduce((acc, [now, before]) => { assert.equal(acc.split(now).length, 2, `25 Nov change not found once: ${now.slice(0, 60)}`); return acc.replace(now, before); }, undoneRuleB);
  const undone1122 = DECISION_CHANGES_2026_11_22.reduce((acc, [now, before]) => { assert.equal(acc.split(now).length, 2, `22 Nov change not found once: ${now.slice(0, 60)}`); return acc.replace(now, before); }, undone1125);
  const undone1103 = DECISION_CHANGES_2026_11_03.reduce((acc, [now, before]) => { assert.equal(acc.split(now).length, 2, `3 Nov change not found once: ${now.slice(0, 60)}`); return acc.replace(now, before); }, undone1122);
  const undone28 = DECISION_CHANGES_2026_10_28.reduce((acc, [now, before]) => { assert.equal(acc.split(now).length, 2, `28 Oct change not found once: ${now.slice(0, 60)}`); return acc.replace(now, before); }, undone1103);
  const undone26 = DECISION_CHANGES_2026_10_26.reduce((acc, [now, before]) => { assert.equal(acc.split(now).length, 2, `26 Oct change not found once: ${now.slice(0, 60)}`); return acc.replace(now, before); }, undone28);
  const undone20 = DECISION_CHANGES_2026_10_20.reduce((acc, [now, before]) => { assert.equal(acc.split(now).length, 2, `20 Oct change not found once: ${now.slice(0, 60)}`); return acc.replace(now, before); }, undone26);
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

test('26 Oct: checked-in wish and no Georgian filler openings', () => {
  const p = renderSystemPrompt(SEED);
  assert.match(p, /Hi, have a comfortable stay, and if you need anything, just message me\./);
  assert.match(p, /36\. Guest has checked in or settled in \(use word for word, nothing before it\): გამარჯობა, კომფორტულად დასვენებას გისურვებთ, თუ რამე დაგჭირდებათ, მომწერეთ\./);
  assert.match(p, /never start a reply with a filler word or acknowledgement such as "კარგია" or "სიამოვნებით"/);
  assert.match(p, /2\. "Thank you" reply: არაფრის, სიამოვნებით\./, 'the plain thank-you reply is kept');
});

test('3 Nov: trash bins at Shartava, never "the cleaning staff will take it"', () => {
  const p = renderSystemPrompt(SEED);
  const t = SEED.policies.trash;
  assert.equal(t.reply.en, 'The trash bins are in front of the building, on the left side. You can throw everything in together, at any time.');
  assert.equal(t.reply.ka, 'ნაგვის ურნები შენობის წინ, მარცხენა მხარესაა. ყველაფერი შეგიძლიათ ერთად გადაყაროთ, ნებისმიერ დროს.');
  assert.deepEqual(t.appliesTo, ['shartava']);
  assert.ok(p.includes(`Reply: ${t.reply.en}`));
  assert.ok(p.includes(`38. Trash bins (use word for word): ${t.reply.ka}`));
  assert.match(p, /Never say the cleaning staff will take out the trash, unless the guest booked a paid cleaning and is asking about that cleaning\./);
  assert.match(p, /must take the trash out before checkout: Reply: Yes, please take the trash out to the bins before you leave\. They are in front of the building, on the left side \(4 bins\)\./, '22 Nov: the owner answered');
  assert.match(NOT_MATCHED_NOTE, /trash bins/, 'an unmatched guest is asked for the booking name first');
});

test('22 Nov: unit amenities and house facts from the owner\'s 50 answers', () => {
  const p = renderSystemPrompt(SEED);
  const { triple, superior, threeBedroom } = SEED.unitTypes;
  assert.equal(triple.expediaName, 'Deluxe Room City View');
  assert.deepEqual([triple.washingMachine, superior.washingMachine, threeBedroom.washingMachine], [false, true, true]);
  assert.match(triple.amenities.en, /no washing machine \(guests can order our paid laundry service/);
  for (const t of [triple.amenities.en, superior.amenities.en, threeBedroom.amenities.en, SEED.policies.amenities.en, SEED.policies.laundry.en, SEED.policies.houseRules.en, SEED.policies.entrance.en, SEED.policies.longStay.en]) {
    assert.ok(p.includes(t), t.slice(0, 50));
  }
  assert.match(superior.variants.en, /Never say which apartments have a city view/);
  assert.doesNotMatch(p, /6-4|7-4/, 'the city view apartments are never named');
  assert.match(p, /Reply exactly: We have 6 Superior Apartments, all the same size, in 3 different designs\./);
  assert.match(p, /- 18 to 23: Reply: We can bring detergent until 18:00 each day, so we'll bring it tomorrow\. \[ESCALATE\]/);
  assert.match(p, /"Stay is longer than 5 nights" line/, 'replaced on 25 Nov (Rule B)');
  assert.match(p, /If everyone still fits the guest's unit \(its maximum in UNIT TYPES\), Reply: That's no problem, thank you for letting us know\. We'll prepare extra bed sheets\. \[ESCALATE\]/);
  assert.match(p, /Reply exactly: Before check-in, you can rebook on the same platform you booked on\. Or you can keep your current booking and pay for the change in cash when you arrive\./);
  assert.ok(p.includes(SEED.policies.bagStorage.afterCheckout.en));
  assert.match(p, /The one exception: a guest asking whether we offer a city tour gets a reply/);
  assert.equal(SEED.policies.entrance.lostKeyFee, 30);
});

test('28 Oct: checkout day, leaving, late checkout never refused', () => {
  const p = renderSystemPrompt(SEED);
  assert.match(p, /Reply: Thank you for letting us know\. Have a safe trip, we hope to see you again\./);
  assert.match(p, /37\. Guest has left or checked out \(use word for word, nothing before it\): მადლობა, რომ შეგვატყობინეთ\. ბედნიერ მგზავრობას გისურვებთ, იმედია ისევ გვესტუმრებით\./);
  assert.match(p, /never refuse on your own, never say it is not possible, and never combine "we can't" with "I'll check"/);
  assert.match(p, /Late checkout request[^\n]*\nReply: Let me check availability based on the next guest arrival and I will get back to you shortly\. \[ESCALATE\]/);
});

test('25 Nov: returning greeting only for a computed new visit, cleaning requests get the paid service', () => {
  const p = renderSystemPrompt(SEED);
  assert.match(p, /Returning guest greeting: only when BOTH are true: the guest context says "Returning guest on a new visit" yes, AND the guest's newest message is only a greeting/);
  assert.match(p, /back-to-back or extended bookings are one stay/);
  assert.doesNotMatch(p, /Returning guest \(previous stay notes exist\)/, 'notes alone no longer trigger the greeting');
  assert.match(p, /Guest asks for cleaning service, including asking for someone to come and clean the apartment, room, bathroom or kitchen during the stay/);
  assert.match(p, /For a stay that is not longer than 5 nights this is not "let me check": use the paid service reply\./, 'reworded the same day for Rule B');
});

test('25 Nov Rule B: cleaning and towels by the whole stay, more than 5 nights gets the team, never a refusal', () => {
  const p = renderSystemPrompt(SEED);
  assert.equal(SEED.policies.longStay.overNights, '5', 'text for the prompt; the code reads it as a number');
  assert.doesNotMatch(p, /7 nights/, 'the free change every 7 nights is gone');
  assert.match(p, /Look at the "Stay is longer than 5 nights" line in the guest context and send only the one matching reply:\n- yes: never refuse, and never mention a price or the paid service\. Reply: Sure, we'll check and arrange it for you\. \[ESCALATE\]/);
  assert.match(p, /- no, or no such line: Reply: Daily cleaning is not included in your reservation price\./);
  assert.match(p, /19\. Extra cleaning request tone \(only when the stay is not longer than 5 nights\)/);
  assert.match(p, /Back-to-back bookings in the same unit are one stay: we don't clean between them/);
});

