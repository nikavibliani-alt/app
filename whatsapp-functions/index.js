const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { defineString } = require('firebase-functions/params');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const crypto = require('node:crypto');
const {
  isShortAcknowledgement,
  isSilentAiReply,
  isWaitingFollowUpAfterEscalation,
  shouldStaySilentFromHistory,
  findMostRecentOwnerMessage,
  isNonTextPlaceholderOnly,
  ownerMuteCutoffMs,
  isConversationStale,
} = require('./ownerSilence');

if (!getApps().length) initializeApp();

// ---- Cloud Tasks config (see README.md "Cloud Tasks setup" for the one-time GCP steps) ----
const TASKS_LOCATION = 'europe-west1';
const TASKS_QUEUE    = 'whatsapp-bot-debounce';
// Set at deploy time (firebase deploy will prompt for these params, or set via
// `firebase functions:secrets:set` / .env.whatsapp). Both are plain (non-secret)
// deploy-time params — see firebase-functions/params.
const WHATSAPP_BOT_WORKER_URL   = defineString('WHATSAPP_BOT_WORKER_URL', { default: '' });
const WHATSAPP_TASKS_INVOKER_SA = defineString('WHATSAPP_TASKS_INVOKER_SA', { default: '' });

// Do NOT require/construct CloudTasksClient at module load — its ADC/network
// discovery can hang Firebase CLI's "Loading and analyzing source code" step
// past the 10s timeout ("Cannot determine backend specification"). Lazily
// require and construct it only when actually enqueueing a task.
let tasksClient = null;
function getTasksClient() {
  if (!tasksClient) {
    // eslint-disable-next-line global-require
    const { CloudTasksClient } = require('@google-cloud/tasks');
    tasksClient = new CloudTasksClient();
  }
  return tasksClient;
}

const SYSTEM_PROMPT = `You are a guest assistant for Maxela Apartments in Tbilisi, Georgia. You handle guest questions via WhatsApp. Be friendly and natural, like a helpful local person. Never sound like a corporate bot.

LANGUAGE RULE:
Figure out the guest's language from what they actually wrote — its content and meaning — never from their phone number or country code (many guests travel on a Georgian SIM while being from somewhere else, so that tells you nothing), and never only from script. Georgian written in Latin letters (transliteration, e.g. "sad aris parkingi", "gamarjoba") is still Georgian even though it has no Georgian Unicode characters — recognize it as Georgian.

If the guest wrote in Georgian, in either script: reply fully in Georgian, as naturally and helpfully as you would in English. Answer their actual question — do not just acknowledge that they wrote in Georgian. When replying in Georgian, always use თქვენ (formal) — never შენ (informal) — for "you" and all related verb conjugations, regardless of how casually the guest writes.

When a guest greets you and asks how you are, in any language, reply warmly and ask them back before answering their actual question — never skip straight to your own status without asking theirs. In Georgian, that looks like: guest "გამარჯობა, როგორ ხარ?" → your reply "გამარჯობა, კარგად, თქვენ? რით შემიძლია დაგეხმაროთ?"

If the guest wrote in any other language (Russian, Arabic, Hebrew, Persian, or anything else): still fully assist them. Reply in English, but warmly — briefly and kindly acknowledge their message, mention naturally that you're replying in English, then answer their actual question normally. Never reply with only "we communicate in English" or anything that sounds like a rejection, a complaint, or a language-barrier statement. It should read like a friendly local who happens to answer in English, not a policy notice.

This applies in every mode, for every guest, every time — never go silent or skip a reply because of the language someone writes in.

TONE RULES:
- Short natural replies, 1-3 sentences maximum
- Never use em dashes ("—") in replies, in any language, they read as an obvious AI-writing tell. Use a comma, period, or separate sentence instead
- No exclamation marks ever, in any language — in Georgian especially, "!" reads as harsh/aggressive, not enthusiastic
- Never preface a question with "I'm asking" / "just to ask" / "so, do you need..." framing (e.g. Georgian გეკითხებით) — ask directly, in any language
- No bullet points or lists in replies
- No dashes in replies
- No AI filler phrases like Certainly, Of course, Thank you for reaching out, I understand, I hope this helps
- Use emojis very sparingly, maximum 1 per message, only when it feels completely natural
- Never sound robotic or like a template
- Never repeat the guest's request back to them before answering — just address it directly, don't restate what they asked
- Avoid overly dramatic or clinically precise words when a calmer, everyday word fits better

RESPONSE SCOPE:
Answer only what the guest actually asked — do not add extra facts, context, or caveats they didn't ask about, even if related. If a guest asks a simple yes/no or short factual question, give a short, direct answer. Only add more detail if the guest's message clearly asks for it, or if it's essential for them to avoid a real problem (e.g. safety, access issues). When unsure whether to include something, leave it out — the guest can always ask a follow-up.

OUTPUT PURITY:
Your response is sent directly to the guest exactly as written, except for the recognized tags ([VIDEO:media_id], [ESCALATE], [URGENT:LOCKOUT], [URGENT:ISSUE], [URGENT:ANGRY], [SILENT], [VIDEO_SENT:media_id]), which are stripped before sending. Never include your reasoning, analysis of context clues, notes about ambiguous or unknown fields, or any explanation of how you arrived at the answer — work that out silently and output only the final guest-facing message. If you are inferring something from the conversation history (e.g. which room the guest is in), do the inference internally and just state the answer; never write out the inference itself.

REPEAT PREVENTION:
Check the conversation history before every reply. If you already answered this exact question earlier in this conversation, do not give the same answer again. If [VIDEO_SENT:id] already appears in history for this topic, do not send the video again — give additional clarification in text only instead. If you already said something like "let me check and get back to you" for this same topic, do not say it again for a follow-up on it — reply with only [SILENT] instead.

ANGRY GUEST DETECTION:
If the guest's message contains language like unacceptable, disgusting, terrible, awful, horrible, refund, compensation, complaint, I'm angry, very disappointed, this is a joke, ridiculous, never coming back, worst, scam, fraud, or cheated, do not attempt to handle it yourself. Reply with only [URGENT:ANGRY] and nothing else — no guest-facing text at all. This alerts the owner immediately and sends nothing to the guest.

CONVERSATION TAKEOVER DETECTION:
If the conversation history shows you or the host already escalated an issue, and the guest's message is a follow-up without a resolution yet appearing in the history, reply with only [SILENT] — the owner is already handling it.

GUEST CONTEXT (injected with each message):
- Guest name
- Room/apartment type
- Check-in and checkout dates
- Whether they filled the check-in form or not
- Previous stay notes if returning guest
- CURRENT_TBILISI_HOUR — the current hour (0-23) in Tbilisi local time

UNIT TYPES (know these well):
- Triple Room with Private Bathroom: no kitchen, no balcony, 1 single bed, 1 double bed, 1 sofa bed, fits up to 4 guests
- Superior Apartment: 1 isolated bedroom with double bed, living room with double bed divided by curtains and 2 sofas, has kitchen, fits up to 6 guests
- 3 Bedroom Apartment: Bedroom 1 has 2 double beds, Bedroom 2 has 1 double bed and 1 baby bed, Bedroom 3 has 1 double bed, living room has 3 sofa beds, 1 separate toilet, 2 bathrooms with showers, has kitchen, fits up to 12 guests
In Georgian, always call the baby bed ბავშვის საწოლი — never სავარძელი (that means armchair).

SCENARIOS:

First contact or reservation confirmation:
Reply: Hi, please fill in this form to get your check-in instructions, everything will be available on that page: app.maxelaapartments.com/checkin-guest

Guest filled form but cannot see instructions:
Reply: It should be visible on that page, try refreshing it.
If they say still not visible: Let me check this with the team and get back to you shortly. [ESCALATE]

QR code not working - guest using screenshot:
Reply: The code refreshes daily so screenshots won't work. Open the page directly: app.maxelaapartments.com/checkin-guest

QR code not working - guest using website:
Reply: Got it, I am alerting the team now to fix this for you. [ESCALATE]

QR code not working - already reported before (check conversation history):
Reply: I see you had this issue before, alerting the team right away. [ESCALATE]

Early check-in request:
Reply (English): Unfortunately I can't guarantee that. Check-in starts at 3pm, and if the room is ready sooner I'll text you.
Reply (Georgian): სამწუხაროდ ვერ მოგცემთ გარანტიას. რეზერვაცია იწყება 15:00 საათიდან, თუ ნომერი დალაგდება უფრო ადრე, მოგწერთ აუცილებლად.

Parking question:
Send parking video (media_id: 975338858914982) then text: We do not have private parking, but there is paid parking in the neighboring building, underneath Carrefour. Daily rate is 15 GEL, cash only. Location: https://maps.app.goo.gl/LArVmJASytmQdReJA

Hot water issue:
If guest is in Triple Room (no kitchen): Reply: Is there any hot water at all or no hot water anywhere?
If guest is in apartment: Reply: Is there hot water in the kitchen tap or no hot water at all?
If no hot water anywhere: We will check this right away, sorry for the inconvenience. [ESCALATE]
If hot water only in kitchen but not bathroom: Send hot water video (media_id: 1819258012553462) then text: Please click the button and scroll in your direction to adjust it.

Something broken and non-urgent (TV, appliance, furniture, faucet), including when the guest asks if a spare or replacement is available:
Reply: Sorry for the inconvenience, let me check on this and get back to you shortly. [ESCALATE]
Never say whether a spare or replacement exists or doesn't, even if you believe you know the answer — always let the owner decide and handle it.

No electricity in the whole apartment:
Reply: There may be an unplanned outage in the area. We will check with City Hall and keep you updated. [ESCALATE]

No electricity in one room or the bathroom only:
Reply: This might be a tripped circuit. We will check it and get back to you shortly. [ESCALATE]

No water in the whole apartment:
Reply: There may be an unplanned outage in the area. We will check with City Hall and keep you updated. [ESCALATE]

Guest reports a gas smell indoors, or any other unidentified bad smell that is not cigarette smoke:
There is no gas supply inside any apartment — gas exists only on balconies. Smell or gas issues are not a cleaning-staff matter — do not say a cleaner will check it, and do not mention who specifically is being sent.
Reply: Sorry about that, we will check on it right away. [ESCALATE]

Guest is locked out, or the smart lock is not working, or its battery is dead:
Reply: I am contacting our team right now and will update you shortly. [ESCALATE] [URGENT:LOCKOUT]

Flooding or a security issue:
Reply: We are looking into this right now and will update you shortly. [ESCALATE] [URGENT:ISSUE]
In Georgian, do not call an everyday bathroom water problem წყალდიდობა — that word implies a large-scale flood and sounds overly dramatic for a leak or water on the floor. Describe the actual problem plainly instead, and reserve strong language for genuine emergencies.

Bag storage before check-in:
Send bag storage video (media_id: 1804812277340997) then text: You can leave your bags in the hallway storage area shown in the video, through the door it shows, under camera surveillance. Just to be safe, we'd suggest not leaving passports, laptops, or other valuables there. Nothing has ever gone missing, but we don't have lockable storage.
If the guest specifically asks for the storage door's password or code, reply: 13 24 13# — but never include this proactively in the default reply, the door is usually already open.
Georgian tone reference: ვიდეო სადაც რჩება, შუშის კარი. შეგიძლიათ ბარგი დატოვოთ ჰოლში, კამერის ქვეშ. ძვირფასი ნივთები მაინც არ დატოვოთ. აქამდე არასდროს წაუღია ვინმეს რამე, მაგრამ სამწუხაროდ საკეტიანი შესანახი არ გვაქვს.

Booking or price inquiry:
Reply: Unfortunately we cannot see exact pricing or availability from our side. Reservations are only through Booking.com or Expedia. Do you need a unit with a kitchen or without?
Once they answer: if they need a kitchen, recommend the Superior Apartment or 3 Bedroom Apartment (both have a kitchen); if not, recommend the Triple Room with Private Bathroom. Either way, send the booking link: booking.com/Share-PaJ0WC. Please make sure to select the right unit type when booking.
When describing this kitchen choice in Georgian, the word is არჩევის (from არჩევა, to choose) — not დარჩევის.

Room type complaint (booked Triple Room but expected kitchen):
Reply: I understand. Just to clarify, you booked the Triple Room with Private Bathroom which does not include a kitchen, as shown in the listing. We also have the Superior Apartment and 3 Bedroom Apartment which both have kitchens. If you have questions about your booking please contact Booking.com or Expedia directly.
If guest insists or is very upset: [ESCALATE]

Guest requests a different apartment, a room with a view, an upgrade, or a room change:
Reply: I'll check on that and let you know shortly. [ESCALATE]
This is a normal request, not something to apologize for — do not apologize or add any other preamble, this alone is enough.
In Georgian, use exactly: შევამოწმებ და გაგაგებინებთ მალე. — no ბოდიშს გიხდით, no other preamble.
Never suggest alternative rooms, views, sightseeing spots, or Tbilisi recommendations to fill the gap while this is pending. Use [SILENT] instead of inventing anything.

Guest mentions Freedom Square, Tabidze, or Galaktion Tabidze street:
This is not our Shartava property, and there is no scenario for it. Use [SILENT] — send nothing, no reply, no escalation. Never use Shartava-specific facts (entrance, address, door codes, etc.) for this guest.
Note: this is enforced in code as a sticky per-conversation flag once detected — every later message in this conversation is also silenced automatically, not just the one that mentioned it.

Gym inquiry:
Reply: We do not have a gym on site.

Airport transfer:
Reply: Yes, you can find the airport transfer option on your check-in page under Services, it will connect you directly with our driver.

Guest asks which entrance to use, or how to find the Shartava location (units starting 0-, 6-, or 7-):
If Filled check-in form is no, first ask: Do you already have a reservation with us?
If they say no: Reply: We don't take direct bookings, sorry, reservations and payment are only through Booking.com or Expedia.
If they say yes: Reply: Please fill in the check-in form first, your entrance and access instructions will be right there: app.maxelaapartments.com/checkin-guest

If Filled check-in form is yes:
If CURRENT_TBILISI_HOUR is 15 or later: Reply: The address is Zhiuli Shartava 35/37, near Clean House Market (https://maps.app.goo.gl/g1wVvjEG3xRn5bNR7). Your check-in page has instructions for finding your specific apartment starting from there.
If CURRENT_TBILISI_HOUR is before 15, check Room/apartment type:
If it starts with 6- or 7- (apartment): Reply: The address is Zhiuli Shartava 35/37, near Clean House Market (https://maps.app.goo.gl/g1wVvjEG3xRn5bNR7), it's the 4th entrance. The door code only switches on at 3pm, sometimes a bit earlier if your apartment gets cleaned ahead of schedule. Just so you know, these are apartments rather than a hotel, so there's no lobby to wait in.
If it starts with 0- (room): Reply: The address is Zhiuli Shartava 35/37, near Clean House Market (https://maps.app.goo.gl/g1wVvjEG3xRn5bNR7), your door is separate, right by the 4th entrance. The door code only switches on at 3pm, sometimes a bit earlier if it gets cleaned ahead of schedule. Just so you know, these are apartments rather than a hotel, so there's no lobby to wait in.
(When replying in Georgian for this scenario, use this exact sentence for the door-code timing, word for word — do not paraphrase it, and never say საღამოს since 3pm is afternoon, not evening: "ინსტრუქციები 3 საათიდან იქნება ხელმისაწვდომი. თუ უფრო მალე დალაგდება ნომერი, 3 საათამდე შეგეძლებათ შესვლა.")

Guest is at or outside the building and says they are stuck, cannot get in, or asks how to get there or where to go:
Check Filled check-in form first. Never reply with "alerting the team" to a generic "I'm stuck" or "how do I get in" message, that wording is only for a genuine smart lock hardware failure (see the locked out scenario above).
If Filled check-in form is no: Reply: Please fill in the check-in form first, your entrance and access instructions will be right there: app.maxelaapartments.com/checkin-guest
If Filled check-in form is yes: Reply: Your entrance and access instructions are on your check-in page, please open it and follow the steps: app.maxelaapartments.com/checkin-guest. If the smart lock still doesn't respond after that, let me know.
If the guest says they already followed the instructions and the smart lock does not react or the code does not work, use the locked out scenario above instead.
If the guest is only asking which entrance to use or where the building is, use the entrance scenario above.

Late checkout request:
Reply: Let me check availability based on the next guest arrival and I will get back to you shortly. [ESCALATE]

Guest asks for the WiFi name or password:
For rooms 0-1 through 0-5: the network is always "Superior Apartments" and the password is always "maxela03" — fixed and identical for every 0-x room.
For 6-x and 7-x apartments: the network name is "maxela [unit]" (e.g. "maxela 6-2") and the password is "maxela" followed by the unit number with no space and no dash, lowercase (e.g. unit 6-2 -> password "maxela62", unit 7-4 -> password "maxela74").
If the guest can't find their network or is confused about the password, explain the pattern using their own unit as the example.

WiFi not working:
Reply: We will check from our side and contact the provider. We will keep you updated.
Note: Do not promise it will be fixed immediately. Do not say it will be resolved soon.
If guest follows up again saying it is still not working: We are still checking on this. [ESCALATE]

Smoking rules - Triple Room:
Reply: Smoking is strictly forbidden in the Triple Room and all shared areas.

Smoking rules - Apartment:
Reply: Smoking is only allowed on the balcony.

Noise complaint:
Reply: Thank you for letting us know, we will look into this immediately. [ESCALATE]

Extra guests beyond booked number:
Reply: Thanks for letting us know, I need to check this with the team and will get back to you shortly. [ESCALATE]

Guest asks for cleaning service:
Reply: Daily cleaning is not included in your reservation price. It is available as an optional paid service. You can arrange it on the guest page: app.maxelaapartments.com/checkin-guest
If guest asks price: Room 30 GEL, Apartment 50 GEL, 3 Bedroom Apartment 70 GEL.

Guest reports the apartment was not cleaned properly:
If CURRENT_TBILISI_HOUR is between 10 and 19: We will get this sorted and let you know when someone is on the way. [ESCALATE]
If CURRENT_TBILISI_HOUR is outside 10-19: Our cleaning staff has finished for today. We will arrange this first thing tomorrow morning. [ESCALATE]

Voice message or audio received:
Reply: Please type your question and I will be happy to help.

Photo or video received:
If there is guest text in this same message, or a clear unanswered question in the guest's immediately preceding message, treat the photo/video as supporting evidence for that text and answer the actual question — do not send the generic fallback. Look carefully at what the image/video actually shows; if it depicts something different from what an earlier answer in this conversation was about (e.g. a different appliance, a different location), do not reuse that earlier answer — address what's actually shown now.
If genuinely unclear what the photo/video shows or what the guest is asking, ask a short clarifying question instead of guessing or repeating an unrelated previous answer.
If a photo with no accompanying text anywhere (this message or the one before it) and nothing in the conversation history clarifies what's being asked: Reply: Sorry, we're unable to view the photo right now, could you describe the issue in a message so we can help?
If a video with no accompanying text anywhere (this message or the one before it) and nothing in the conversation history clarifies what's being asked: Reply: Sorry, we're unable to view the video right now, could you describe the issue in a message so we can help?

Returning guest (previous stay notes exist):
Reply: Good to hear from you again. How can I help?

Restaurants, tourist attractions, sightseeing, transport unrelated to our service, or general Tbilisi questions:
Use [SILENT] — send nothing, no reply, no escalation. Never invent recommendations to sound helpful.

Anything else outside the above topics:
Reply: Let me check on that and get back to you shortly. [ESCALATE]

FACTUALITY RULE (never invent):
Only use facts from this prompt, the guest context, and the conversation history. Never invent sightseeing tips, restaurant recommendations, city information, room availability, prices, or policies that are not explicitly covered above. If you are unsure or the request needs a human decision, escalate instead of guessing.

FOR SENDING VIDEOS:
When a scenario requires a video, start your response with [VIDEO:media_id] on its own line followed by the text message.
Example:
[VIDEO:975338858914982]
The nearest paid parking is under Carrefour...

FOR FOLLOW-UP QUESTIONS:
Before replying, check whether the guest's message is a follow-up about something you already answered earlier in this conversation history. If it is, do not repeat the same answer and do not send the same video again — acknowledge what you already told them and give additional clarification instead.
If a past Assistant turn in the history contains [VIDEO_SENT:media_id], that video has already been sent in this conversation for that topic. Do not include [VIDEO:media_id] again for the same topic in your reply. [VIDEO_SENT:...] is a system marker only — never write it yourself.
Example: you already sent the bag storage video and explained it. Guest asks "is it on the street?" — answer that specific question in plain text (e.g. clarify the location) instead of resending the video.

FOR ESCALATION:
When you include [ESCALATE] in your response, place it at the very end after the guest-facing text. It will be stripped before sending to the guest and used internally to alert the owner.
Example: Sorry about that, I am alerting the team now. [ESCALATE]

FOR STAYING SILENT:
When a scenario says to use [SILENT], or the conversation history already shows a Host: message that answered the guest, reply with only [SILENT] and nothing else. This sends no message to the guest at all. Also use only [SILENT] if the guest's message is just a short acknowledgement (ok, okay, thanks, got it, sure, etc.) after a Host: or Assistant: message that already closed the topic.

FOR URGENT ISSUES:
For a guest lockout or smart lock failure, add [URGENT:LOCKOUT] right after [ESCALATE]. For flooding or a security issue, add [URGENT:ISSUE] right after [ESCALATE]. Both tags are stripped before sending and trigger an immediate owner alert regardless of bot mode or time of day.
Example: I am contacting our team right now and will update you shortly. [ESCALATE] [URGENT:LOCKOUT]
[URGENT:ANGRY] is different — see ANGRY GUEST DETECTION above. Use it alone, with no guest-facing text, unlike [URGENT:LOCKOUT]/[URGENT:ISSUE] which come after a normal reply.

GEORGIAN PHRASING REFERENCE (tone/style examples, not fixed scripts):
These are not scripts to output verbatim. They show how the owner wants Georgian replies to sound — natural, warm, correctly formal (თქვენ, never შენ), and appropriately concise. For each guest message, generate a fresh, context-appropriate reply based on what the guest actually said — calibrated to match this tone, formality, and phrasing pattern, not copied word-for-word regardless of context.

1. First "hello": გამარჯობა, რით შემიძლია დაგეხმაროთ?
2. "Thank you" reply: არაფრის, სიამოვნებით. კიდევ თუ რამე დაგჭირდებათ, მომწერეთ.
3. Checkout day goodbye: მშვიდობით, გისურვებთ კარგ მგზავრობას.
4. "How are you?": კარგად, თქვენ? რით შემიძლია დაგეხმაროთ?
5. "Are you a bot?": მე ვარ Maxela Apartments-ის ვირტუალური ასისტენტი, სიამოვნებით დაგეხმარებით.
6. Standard check-in time: სტანდარტული check-in 15:00 საათიდან არის შესაძლებელი.
7. Early check-in request (tone reference — see the actual policy above): თუ ბინა ადრე გათავისუფლდება და დასუფთავდება, რა თქმა უნდა. ადრე დასუფთავების შემთხვევაში მოგწერთ აუცილებლად.
8. Entrance/address tone (full logic is the existing entrance scenario — this is tone only): მისამართი და შესვლის ინსტრუქცია არის სტუმრის გვერდზე: [link]
9. "Where's the door code" tone: კარის კოდი შესვლის ინსტრუქციის გვერდზეა, ჩამოსქროლეთ ბოლო საფეხურზე.
10. Check-in form issue tone: ბოდიში, შევამოწმებ ახლავე.
11. Standard checkout time: checkout არის 12:00 საათამდე.
12. Late checkout request tone: გადავამოწმებთ ჯავშნების განრიგს და მალევე შეგატყობინებთ.
13. Where to leave keys: გასაღები დატოვეთ ბინაში, კარი უბრალოდ მიხურეთ გამოსვლისას.
14. Forgot item tone: დამლაგებელთან შევამოწმებთ და მალევე მოგწერთ.
15. WiFi tone (see the WiFi scenario above for the actual logic): ვაიფაის სახელი და პაროლი თითქმის ერთნაირია, მაგალითად, ბინა maxela 6-2-ის ვაიფაის სახელია maxela 6-2, ხოლო პაროლია maxela62, პატარა ასოებით, გამოტოვების და მინუსის გარეშე.
16. Internet not working tone: ბოდიში, შევამოწმებ და მალე მოგწერთ.
17. TV not working tone: ბოდიში, შევამოწმებ რაღაცას და მოგწერთ მალე.
18. Parking availability: სამწუხაროდ ჩვენი პარკინგი არ გვაქვს, მაგრამ ახლოს არის ფასიანი პარკინგი, დღეში 15 ლარი.
19. Extra cleaning request tone: სამწუხაროდ რეზერვაციაში დალაგება არ შედის, მაგრამ შესაძლებელია ცალკე დალაგების სერვისით სარგებლობა.
20. Cleaning done badly tone (correct phrasing of the complaint is "ბინა ცუდად არის დალაგებული"): ძალიან ვწუხვართ და ბოდიშს გიხდით. შევამოწმებ დამლაგებელი თუ თავისუფალია და შეგატყობინებთ მოსვლის დროს.
21. When will cleaner come tone: ბოდიში, შევამოწმებ ვინ არის ახლოს და მოგწერთ რამდენ ხანში მოვალთ.
22. No hot water — correct clarifying question form (this is the full reply, no extra sentence needed): ცხელი წყალი მხოლოდ აბაზანაში არ არის თუ სამზარეულოშიც?
23. Power out in whole apartment: ეს დაუგეგმავი გათიშვაა ალბათ, გადაამოწმეთ City Hall-ის საიტზე.
24. No water at all: დაუგეგმავი გათიშვა უნდა იყოს, გადავამოწმებთ ჩვენც.
25. Room doesn't match photos tone: ბოდიშს გიხდით შეგრძნებისთვის, გვითხარით კონკრეტულად რა გაწუხებთ და შევეცდებით გამოვასწოროთ.
26. Noisy neighbors tone: ბოდიშს გიხდით შეწუხებისთვის, ახლავე გადავამოწმებთ.
27. Dirty linens tone: ბოდიშს გიხდით, ახლავე შევცვლით.
28. Locked out (urgent) tone: ბოდიში, შევამოწმებ ვინ არის ახლოს და მოგწერთ რამდენ ხანში მოვალთ.
29. Returning guest exchange tone:
Guest: "გამარჯობა, ისევ თქვენთან ვჯავშნი, გახსოვართ?"
Bot: "დიახ, რა თქმა უნდა, როგორ ხართ? მიხარია რომ ჩვენთან დაჯავშნეთ."
30. Guest expresses satisfaction at checkout: ძალიან მიხარია, დიდი მადლობა, იმედია ისევ დაბრუნდებით 😊🥰
31. Pets: სამწუხაროდ ცხოველების დაშვება არ არის შესაძლებელი.
32. Nearest pharmacy: აფთიაქი ქუჩაშია ხელ მარჯვნივ.
33. Nearest shop: მაღაზიები არის მარჯვნივ ქუჩაზე.
34. Nearby restaurant recommendations: სამწუხაროდ ამაზე რეკომენდაციას ვერ გაგიწევთ, გირჩევთ Google Maps-ზე გადახედოთ.
35. Guest is very happy, thanks the host: დიდი მადლობა თქვენ, სასიამოვნო იყო თქვენი მასპინძლობა.`;

const SUMMARY_SYSTEM_PROMPT = 'Summarize this guest WhatsApp conversation into 3-5 bullet points covering: issues they had, requests they made, how they communicated, anything notable. Be very brief.';

/** Strip spaces/dashes/parens/+ so Meta and form phones compare as digits-only. */
function normalizePhone(phone) {
  return String(phone || '').replace(/[\s\-().]/g, '').replace(/^\+/, '').replace(/\D/g, '');
}

/** Contact values commonly stored in checkin_guests for the same WhatsApp number. */
function phoneQueryVariants(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return [];
  const variants = new Set([normalized, `+${normalized}`]);
  return [...variants];
}

/**
 * Look up a WA check-in guest by contact, trying both digits-only and +digits forms.
 * Returns the first matching document data, or null.
 */
async function findGuestByWhatsAppPhone(db, phone) {
  const variants = phoneQueryVariants(phone);
  for (const contact of variants) {
    const snap = await db.collection('checkin_guests')
      .where('contact', '==', contact)
      .where('contactType', '==', 'wa')
      .limit(1)
      .get();
    if (!snap.empty) return snap.docs[0].data();
  }
  return null;
}

/** matchedReservationId may be "007004653_001" — base reservation number is before first _. */
function baseReservationNumber(matchedReservationId) {
  const raw = String(matchedReservationId || '').trim();
  if (!raw) return '';
  return raw.split('_')[0];
}

function guestFirstName(fullName) {
  const name = String(fullName || '').trim();
  if (!name) return 'Guest';
  return name.split(/\s+/)[0];
}

async function alreadySentRoomReady(db, reservationNumber) {
  if (!reservationNumber) return false;
  const docs = await db.collection('whatsapp_messages')
    .where('reservationNumber', '==', String(reservationNumber))
    .where('job', '==', 'room_ready')
    .where('status', '==', 'sent')
    .limit(1)
    .get();
  return !docs.empty;
}

async function writeRoomReadyRecord(db, { reservationNumber, guestName, phone, status, metaMessageId = '' }) {
  await db.collection('whatsapp_messages').add({
    reservationNumber: String(reservationNumber || ''),
    guestName: guestName || '',
    phone: phone || '',
    job: 'room_ready',
    status,
    metaMessageId,
    createdAt: FieldValue.serverTimestamp(),
  });
}

async function callClaude({ system, messages, maxTokens = 500 }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });

  const data = await res.json();
  return data?.content?.[0]?.text || '';
}

async function sendWhatsAppMessage(payload) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${process.env.META_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }
  );
  return res.json();
}

function toJsDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Bot config / mode resolution ------------------------------------------

const CONFIG_DEFAULTS = {
  aiBotEnabled: true,
  botMode: 'available',
  botResponseDelay: 20,
  ownerPhone: '',
  nightStart: 22,
  nightEnd: 9,
  ownerSilenceWindowMinutes: 30,
  // Flat mute after any manual owner message: the bot stays silent for this long.
  ownerMuteMinutes: 5,
  // If the conversation's last message (either side) is older than this, a new
  // guest message waits staleGraceSeconds (floor 10) before the bot replies, so
  // the owner can answer first. All three live in globals/config, editable
  // without a redeploy.
  staleConversationMinutes: 60,
  staleGraceSeconds: 60,
};

async function getGlobalsConfig(db) {
  try {
    const snap = await db.collection('globals').doc('config').get();
    return snap.exists ? { ...CONFIG_DEFAULTS, ...snap.data() } : { ...CONFIG_DEFAULTS };
  } catch (err) {
    console.error('getGlobalsConfig failed:', err);
    return { ...CONFIG_DEFAULTS };
  }
}

/** Current hour (0-23) in Tbilisi local time. Georgia is UTC+4 year-round, no DST. */
function tbilisiHour(date = new Date()) {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tbilisi',
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(date);
  return Number(formatted) % 24;
}

function isNightHour(hour, nightStart, nightEnd) {
  if (nightStart === nightEnd) return false; // no window configured — treat as always available
  if (nightStart > nightEnd) return hour >= nightStart || hour < nightEnd; // wraps past midnight, e.g. 22 -> 9
  return hour >= nightStart && hour < nightEnd;
}

/**
 * Resolve the effective bot mode ("available" | "away" | "night") from config.botMode.
 * Does NOT consider aiBotEnabled — callers must check that separately (hard kill switch).
 */
function resolveEffectiveMode(config) {
  if (config.botMode === 'away') return 'away';
  if (config.botMode === 'night') return 'night';
  if (config.botMode === 'auto') {
    const hour = tbilisiHour();
    return isNightHour(hour, Number(config.nightStart), Number(config.nightEnd)) ? 'night' : 'available';
  }
  return 'available';
}

function buildModeContext(effectiveMode, ownerPhone) {
  if (effectiveMode === 'away') {
    return 'AWAY MODE: The owner may be unreachable (traveling/no internet). Be helpful with everything you can. For escalations that require human action, tell the guest: I have noted this and someone from our team will follow up as soon as possible. Do not promise immediate response times. If a Host: message appears in the history after the guest request, the owner has returned and already replied — respond with only [SILENT] and do not add extra tips after that.';
  }
  if (effectiveMode === 'night') {
    let text = 'NIGHT MODE: It is currently nighttime in Tbilisi. For escalations that require urgent human action, tell the guest: If this is urgent please call the night contact number provided below, otherwise we will get back to you first thing in the morning.';
    const normalizedOwner = normalizePhone(ownerPhone);
    if (normalizedOwner) {
      text += `\nNight contact number: +${normalizedOwner}`;
    }
    text += ' If a Host: message already answered the guest, reply with only [SILENT].';
    return text;
  }
  return 'AVAILABLE MODE: A human host may reply manually. If the conversation history already contains a Host: message that answered the guest, reply with only [SILENT]. Guest should never be told they are talking to a bot.';
}

async function writeAlert(db, { reason, phone, guestName = '', room = '', message = '', mode = '', urgency = false }) {
  try {
    await db.collection('whatsapp_alerts').add({
      reason,
      phone: phone || '',
      guestName,
      room,
      message,
      mode,
      urgency: !!urgency,
      resolved: false,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('writeAlert failed:', err);
  }
}

/** Best-effort free-form WhatsApp notification to the owner. Never throws. */
async function notifyOwner(ownerPhone, text) {
  const to = normalizePhone(ownerPhone);
  if (!to) return;
  try {
    const data = await sendWhatsAppMessage({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    });
    if (!data?.messages) {
      console.error('notifyOwner: Meta error —', JSON.stringify(data));
    }
  } catch (err) {
    console.error('notifyOwner: fetch failed:', err);
  }
}

// ---- Inbound content classification ----------------------------------------

/** Returns the text to store for an inbound message, or a bracketed placeholder for non-text types. */
function classifyIncomingContent(msg) {
  if (msg.text?.body) return msg.text.body;
  const type = msg.type;
  if (type === 'audio' || type === 'voice') return '[audio]';
  if (type === 'image' || type === 'sticker') return '[image]';
  if (type === 'video') return '[video]';
  return '[unsupported]';
}

// ---- Freedom Square / Tabidze sticky silence --------------------------------
// Freedom Square guests are not at our Shartava property and we have no
// scenario for them — once a guest's message mentions this area, the bot must
// never speak to that conversation again, since any of our factual scenarios
// (Shartava entrance, bag storage, etc.) would be wrong for their location.
// Deliberately excludes a bare "galaktion" (a common Georgian first name,
// unrelated to the street) — only "tabidze" alone or "galaktion tabidze"
// together are treated as unambiguous.
// Georgian word stems (not full words) on purpose — Georgian noun declension
// changes the ending (e.g. "ტაბიძის" = "of Tabidze's"), so matching the stem
// catches every grammatical case, not just the nominative form.
const FREEDOM_SQUARE_KEYWORDS = [
  'freedom square',
  'tabidze',
  'galaktion tabidze',
  'თავისუფლების მოედანი',
  'თავისუფლების',
  'ტაბიძ',
  'გალაკტიონ ტაბიძ',
  'tavisuplebis moedani',
  'tavisuplebis',
];
const FREEDOM_SQUARE_RE = new RegExp(FREEDOM_SQUARE_KEYWORDS.join('|'), 'iu');

/** True if `text` mentions Freedom Square / Tabidze by any known spelling. */
function isFreedomSquareMessage(text) {
  return FREEDOM_SQUARE_RE.test(String(text || ''));
}

/**
 * Meta can redeliver the same webhook payload (slow/ambiguous response,
 * network retries), which would otherwise rotate whatsapp_pending's
 * batchToken a second time and double-log the conversation. Claims
 * `messageId` exactly once via an atomic create() — no get-then-set race
 * window. Returns true if this is a genuine duplicate (already claimed).
 */
async function isDuplicateMessage(db, messageId) {
  if (!messageId) return false; // no id to dedupe on — process normally
  const seenRef = db.collection('whatsapp_messages_seen').doc(messageId);
  try {
    await seenRef.create({
      messageId,
      // TTL-friendly: point a Firestore TTL policy (console/gcloud, not
      // application code) at this field to auto-expire old dedup records —
      // see README "Duplicate webhook delivery" section.
      processedAt: FieldValue.serverTimestamp(),
    });
    return false; // we just claimed it — first delivery
  } catch (err) {
    if (err.code === 6 || /already exists/i.test(err.message || '')) {
      return true; // ALREADY_EXISTS — a prior delivery already claimed this id
    }
    // Unexpected Firestore error — log and treat as not-a-duplicate so we
    // never silently drop a legitimate message over a transient hiccup.
    console.error(`isDuplicateMessage: create() failed for ${messageId}, proceeding anyway:`, err);
    return false;
  }
}

/** Drops any in-flight debounced batch for a phone. Best-effort. */
async function clearPendingForPhone(db, phone) {
  try {
    await db.collection('whatsapp_pending').doc(phone).delete();
  } catch (err) {
    console.warn('clearPendingForPhone failed:', err.message || err);
  }
}

// ---- Message batching (whatsapp_pending) ------------------------------------

/** Adds `text` to the guest's pending batch, rotating batchToken so any in-flight worker for the old token no-ops. */
async function upsertPendingMessage(db, phone, text, graceSeconds = 0) {
  const batchToken = crypto.randomUUID();
  const pendingRef = db.collection('whatsapp_pending').doc(phone);
  // Stale-conversation grace deadline (ms epoch), set once when the batch starts
  // so later messages in the same burst can't shorten the wait.
  let graceUntilMs = 0;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(pendingRef);
    if (snap.exists) {
      graceUntilMs = Number(snap.data().graceUntilMs) || 0;
      tx.update(pendingRef, {
        messages: FieldValue.arrayUnion(text),
        lastMessageAt: FieldValue.serverTimestamp(),
        batchToken,
        phone,
      });
    } else {
      graceUntilMs = graceSeconds > 0 ? Date.now() + graceSeconds * 1000 : 0;
      tx.set(pendingRef, {
        messages: [text],
        batchStartedAt: FieldValue.serverTimestamp(),
        lastMessageAt: FieldValue.serverTimestamp(),
        batchToken,
        phone,
        ...(graceUntilMs ? { graceUntilMs } : {}),
      });
    }
  });
  return { batchToken, graceUntilMs };
}

/** Deletes whatsapp_pending/{phone} only if its batchToken still matches — avoids racing a newer burst. */
async function deletePendingIfTokenMatches(db, phone, batchToken) {
  const pendingRef = db.collection('whatsapp_pending').doc(phone);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(pendingRef);
    if (snap.exists && snap.data().batchToken === batchToken) {
      tx.delete(pendingRef);
    }
  });
}

/** Enqueues a Cloud Task that calls whatsappBotWorker after `delaySeconds`. Logs and no-ops on failure. */
async function enqueueBotWorker({ phone, batchToken, delaySeconds }) {
  console.log(`enqueueBotWorker called for phone: ${phone}`);

  const workerUrl = WHATSAPP_BOT_WORKER_URL.value();
  if (!workerUrl) {
    console.error('enqueueBotWorker: WHATSAPP_BOT_WORKER_URL is not configured — see README "Cloud Tasks setup"');
    return;
  }

  try {
    const project  = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'sleepy-5c962';
    const client = getTasksClient();
    const queuePath = client.queuePath(project, TASKS_LOCATION, TASKS_QUEUE);
    const invokerSa = WHATSAPP_TASKS_INVOKER_SA.value();

    const task = {
      httpRequest: {
        httpMethod: 'POST',
        url: workerUrl,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ phone, batchToken })).toString('base64'),
        ...(invokerSa ? { oidcToken: { serviceAccountEmail: invokerSa } } : {}),
      },
      scheduleTime: { seconds: Math.floor(Date.now() / 1000) + Math.max(0, Math.round(delaySeconds)) },
    };

    await client.createTask({ parent: queuePath, task });
  } catch (err) {
    // Widened to cover getTasksClient()/queuePath() too, not just createTask —
    // a client-construction failure used to bypass this log entirely and only
    // surface as a generic "whatsappWebhook error:" from the outer handler.
    console.error('enqueueBotWorker: failed to enqueue task:', err);
  }
}

// -----------------------------------------------------------------------------

exports.whatsappWebhook = onRequest(
  { region: 'europe-west1', cors: true, secrets: ['WEBHOOK_VERIFY_TOKEN', 'META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID', 'ANTHROPIC_API_KEY'] },
  async (req, res) => {
    // GET — Meta webhook verification
    if (req.method === 'GET') {
      const mode  = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Forbidden');
    }

    // POST — incoming message / echo. Architecture rule: no long waits here — accept
    // work, hand off delayed replies to the Cloud Tasks worker, return 200 fast.
    if (req.method === 'POST') {
      try {
        const body  = req.body;
        const change = body?.entry?.[0]?.changes?.[0];
        const field = change?.field;
        const value = change?.value;
        const db    = getFirestore();

        // Diagnostic visibility only (no behavior change) — logs the webhook `field`
        // whenever it's anything other than the normal inbound-message type, so we
        // can tell from Cloud Run logs alone whether smb_message_echoes (or any
        // other field) is actually being delivered, without needing dashboard access.
        if (field && field !== 'messages') {
          console.log('whatsappWebhook: received non-messages field:', field, 'value:', JSON.stringify(value)?.slice(0, 1000));
        }

        // CHANGE 3 — coexistence owner echoes (owner/app replied from the WhatsApp Business app).
        // Field name per Meta's Business Coexistence webhook; some accounts may expose it as
        // `message_echoes` instead — check both defensively.
        const echoes = value?.smb_message_echoes || value?.message_echoes;
        if ((value?.smb_message_echoes !== undefined || value?.message_echoes !== undefined) && !(Array.isArray(echoes) && echoes.length > 0)) {
          // Echo field present on the payload but empty or not the array shape we expect —
          // log the raw value so a mismatch in Meta's actual schema is visible, not silent.
          console.log('whatsappWebhook: echo field present but empty/unmatched, raw value:', JSON.stringify(value)?.slice(0, 1000));
        }
        if (Array.isArray(echoes) && echoes.length > 0) {
          console.log('whatsappWebhook: smb_message_echoes matched, count:', echoes.length);
          for (const echo of echoes) {
            // An echo is a message the business (owner) sent TO the guest, so the guest's
            // number is `to`, not `from` (which is the business number).
            const guestPhone = normalizePhone(echo.to || echo.recipient_id || echo.from);
            if (!guestPhone) continue;
            const echoText = echo.text?.body || classifyIncomingContent(echo);
            await db.collection('whatsapp_conversations').doc(guestPhone)
              .collection('messages').add({
                role: 'owner',
                content: echoText,
                timestamp: FieldValue.serverTimestamp(),
                metaMessageId: echo.id || null,
              });
            // Owner took over (any mode) — drop any debounced bot batch so the bot
            // cannot talk over the host after they return and reply on iPhone.
            await clearPendingForPhone(db, guestPhone);
          }
          // Owner echoes never enqueue a bot reply.
          return res.sendStatus(200);
        }

        const messages = value?.messages;

        // Status updates / other non-message payloads — acknowledge and exit
        if (!messages || messages.length === 0) {
          return res.sendStatus(200);
        }

        const msg   = messages[0];

        // Dedupe Meta's redelivered webhooks before any other processing —
        // must run before whatsapp_pending's batchToken can rotate a second
        // time for the same physical message.
        if (await isDuplicateMessage(db, msg.id)) {
          console.log(`whatsappWebhook: duplicate message ${msg.id} — already processed, skipping`);
          return res.sendStatus(200);
        }

        const phone = normalizePhone(msg.from);
        if (!phone) return res.sendStatus(200);

        const text = classifyIncomingContent(msg);

        const convoRef    = db.collection('whatsapp_conversations').doc(phone);
        const messagesRef = convoRef.collection('messages');

        // Last message in the conversation (either side) BEFORE this one, for the
        // stale-conversation grace delay below. Must be read before the add.
        const prevSnap = await messagesRef.orderBy('timestamp', 'desc').limit(1).get();
        const prevAt = prevSnap.empty ? null : toJsDate(prevSnap.docs[0].data().timestamp);

        // Always persist the inbound message first, regardless of bot state
        await messagesRef.add({
          role: 'user',
          content: text,
          timestamp: FieldValue.serverTimestamp(),
          metaMessageId: msg.id || null,
        });

        const config = await getGlobalsConfig(db);

        // CHANGE 1 — hard kill switch. The inbound message is already saved (above,
        // unconditionally); no alert and no Cloud Task while paused — alerts are
        // reserved for when the bot is ON but can't handle something itself.
        if (config.aiBotEnabled === false) {
          return res.sendStatus(200);
        }

        // CHANGE 2 — batch into whatsapp_pending and hand off to the Cloud Tasks worker
        const effectiveMode = resolveEffectiveMode(config);
        const configuredDelay = Number(config.botResponseDelay) || CONFIG_DEFAULTS.botResponseDelay;

        // Stale-conversation grace: after a long silence, give the owner a chance to
        // answer first. Available mode only (in Away/night the owner isn't expected).
        const staleMinutes = Number(config.staleConversationMinutes) || CONFIG_DEFAULTS.staleConversationMinutes;
        const graceSeconds = Math.max(10, Number(config.staleGraceSeconds) || CONFIG_DEFAULTS.staleGraceSeconds);
        const stale = effectiveMode === 'available'
          && isConversationStale(prevAt ? prevAt.getTime() : NaN, Date.now(), staleMinutes);

        const { batchToken, graceUntilMs } = await upsertPendingMessage(db, phone, text, stale ? graceSeconds : 0);

        // Away/night still debounce rapid bursts, but don't make the guest wait the full
        // human-first delay — cap at 3s.
        let delaySeconds = effectiveMode === 'available' ? configuredDelay : Math.min(configuredDelay, 3);
        if (graceUntilMs) {
          delaySeconds = Math.max(delaySeconds, Math.ceil((graceUntilMs - Date.now()) / 1000));
        }

        await enqueueBotWorker({ phone, batchToken, delaySeconds });

        return res.sendStatus(200);
      } catch (err) {
        console.error('whatsappWebhook error:', err);
        return res.sendStatus(200);
      }
    }

    return res.sendStatus(405);
  }
);

// ---- Deferred worker: builds the reply for one debounced batch --------------

exports.whatsappBotWorker = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 60,
    // Cold start loads firebase-admin/firestore's full dependency graph
    // (google-gax + @opentelemetry/api + large proto JSON descriptors) —
    // measured locally as needing well over the platform's default (small)
    // memory tier under load, sometimes contending for close to 2GB of V8
    // heap. Underprovisioned memory here is a leading suspect for a cold
    // start that OOM-kills the instance before the handler ever runs.
    memory: '512MiB',
    // Pin the invoker to the Cloud Tasks service account by name, rather than
    // 'private' + a manual `gcloud run services add-iam-policy-binding`. With
    // 'private', Firebase doesn't manage any invoker binding at all, so the
    // manual grant was invisible to deploy's own IAM reconciliation and got
    // wiped on the next deploy. Declaring the principal here makes Firebase
    // (re-)apply this exact Cloud Run Invoker binding on every deploy.
    invoker: 'whatsapp-tasks-invoker@sleepy-5c962.iam.gserviceaccount.com',
    secrets: ['META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID', 'ANTHROPIC_API_KEY'],
  },
  async (req, res) => {
    console.log('whatsappBotWorker: raw request received');
    try {
      console.log('whatsappBotWorker: request received', JSON.stringify(req.body).substring(0, 200));

      const { phone, batchToken } = req.body || {};
      if (!phone || !batchToken) {
        console.error('whatsappBotWorker: STOPPED — missing phone or batchToken in payload');
        return res.sendStatus(200); // malformed task — don't retry
      }

      const db = getFirestore();
      const config = await getGlobalsConfig(db);
      console.log('whatsappBotWorker: config loaded, aiBotEnabled:', config.aiBotEnabled, 'botMode:', config.botMode);

      // Kill switch may have flipped after the task was enqueued
      if (config.aiBotEnabled === false) {
        console.log('whatsappBotWorker: STOPPED — aiBotEnabled is false for', phone);
        return res.sendStatus(200);
      }

      const pendingRef = db.collection('whatsapp_pending').doc(phone);
      const pendingSnap = await pendingRef.get();
      // Note: Admin SDK — `exists` is a boolean property here, not a method (unlike the
      // client/Web SDK's `exists()`). Using () would throw "not a function" at runtime.
      console.log('whatsappBotWorker: looking for pending doc at path:', `whatsapp_pending/${phone}`, 'exists:', pendingSnap.exists);
      console.log('whatsappBotWorker: task batchToken:', batchToken, 'firestore batchToken:', pendingSnap.exists ? pendingSnap.data().batchToken : 'DOC_NOT_FOUND');
      if (!pendingSnap.exists) {
        console.log('whatsappBotWorker: STOPPED — no whatsapp_pending doc for', phone);
        return res.sendStatus(200);
      }

      const pending = pendingSnap.data();
      console.log('whatsappBotWorker: processing phone:', phone, 'messages count:', (pending.messages || []).length);
      // A newer message arrived and rescheduled work under a fresh token — this run is stale
      if (pending.batchToken !== batchToken) {
        console.log('whatsappBotWorker: STOPPED — stale batchToken for', phone, '(pending has a newer batch)');
        return res.sendStatus(200);
      }

      const effectiveMode = resolveEffectiveMode(config);
      const convoRef        = db.collection('whatsapp_conversations').doc(phone);
      const convoMessagesRef = convoRef.collection('messages');
      const combinedGuestText = (pending.messages || []).join('\n');

      // Freedom Square / Tabidze sticky silence — once flagged, always silent
      // for this conversation. Checked before every other branch since it must
      // override everything else (owner replies, escalations, etc. are moot —
      // the bot should never speak to this conversation again).
      const convoSnap = await convoRef.get();
      const alreadyFreedomSquare = convoSnap.exists && convoSnap.data().isFreedomSquare === true;
      if (alreadyFreedomSquare || isFreedomSquareMessage(combinedGuestText)) {
        if (!alreadyFreedomSquare) {
          await convoRef.set({ isFreedomSquare: true }, { merge: true });
          console.log('whatsappBotWorker: Freedom Square/Tabidze keyword detected — flagging', phone, 'silent for good');
        }
        console.log('whatsappBotWorker: STOPPED — Freedom Square/Tabidze sticky silence for', phone);
        await deletePendingIfTokenMatches(db, phone, batchToken);
        return res.sendStatus(200);
      }

      // CHANGE 5 — owner mute, in ALL modes. The bot stays silent if the owner sent
      // any manual message within the last ownerMuteMinutes (flat timer from that
      // message, independent of guest activity), OR at any point since this batch
      // started. Available-only used to miss the Away incident: the host returned,
      // answered, and the bot still talked over them.
      const ownerMuteMinutes = Number(config.ownerMuteMinutes) || CONFIG_DEFAULTS.ownerMuteMinutes;
      const batchStartDate = toJsDate(pending.batchStartedAt || pending.lastMessageAt);
      const ownerMuteCutoff = () => new Date(ownerMuteCutoffMs(
        Date.now(),
        batchStartDate ? batchStartDate.getTime() : NaN,
        ownerMuteMinutes
      ));
      const ownerMuted = async () => {
        const snap = await convoMessagesRef
          .where('role', '==', 'owner')
          .where('timestamp', '>=', ownerMuteCutoff())
          .limit(1)
          .get();
        return !snap.empty;
      };
      if (await ownerMuted()) {
        console.log('whatsappBotWorker: STOPPED — owner mute (manual reply within', ownerMuteMinutes, 'min or since batch started) for', phone);
        await deletePendingIfTokenMatches(db, phone, batchToken);
        return res.sendStatus(200);
      }

      // Last 15 messages, fetched once and reused both for the silence checks
      // below (newest-first) and as Claude's conversation history (reversed).
      const historySnap = await convoMessagesRef.orderBy('timestamp', 'desc').limit(15).get();
      const recentNewestFirst = historySnap.docs.map((d) => d.data());

      // CHANGE F — owner continuation silence: the most recent owner message (not
      // necessarily the directly preceding one) is still fresh (within
      // ownerSilenceWindowMinutes) and the guest's follow-up isn't a clear new
      // topic (approximated here the same way CHANGE 6 does: a short ack).
      const ownerSilenceWindowMinutes = Number(config.ownerSilenceWindowMinutes) || CONFIG_DEFAULTS.ownerSilenceWindowMinutes;
      const lastOwnerMsg = findMostRecentOwnerMessage(recentNewestFirst);
      if (lastOwnerMsg) {
        const ownerAt = toJsDate(lastOwnerMsg.timestamp);
        const withinWindow = ownerAt && (Date.now() - ownerAt.getTime()) < ownerSilenceWindowMinutes * 60 * 1000;
        if (withinWindow && (
          isShortAcknowledgement(combinedGuestText)
          || isWaitingFollowUpAfterEscalation(combinedGuestText, lastOwnerMsg.content)
          || isNonTextPlaceholderOnly(combinedGuestText)
        )) {
          console.log('whatsappBotWorker: STOPPED — owner continuation silence (within window + short ack/waiting nudge/non-text) for', phone);
          await deletePendingIfTokenMatches(db, phone, batchToken);
          return res.sendStatus(200);
        }
      }

      // CHANGE 6 — guest only said "okay"/"thanks" after the host (or the bot)
      // already closed the topic in the immediately preceding turn.
      if (shouldStaySilentFromHistory(recentNewestFirst, combinedGuestText)) {
        console.log('whatsappBotWorker: STOPPED — short-ack-after-owner/assistant silence for', phone);
        await deletePendingIfTokenMatches(db, phone, batchToken);
        return res.sendStatus(200);
      }

      // Guest lookup (reuses the checkin_guests phone-variant + multi-room fixes)
      const form = await findGuestByWhatsAppPhone(db, phone);

      let guestName    = 'Guest';
      let roomCode     = '';
      let checkinDate  = '';
      let checkoutDate = '';
      let hasFilledForm = false;

      if (form) {
        hasFilledForm = true;
        guestName = form.name || 'Guest';
        const resNumber = baseReservationNumber(form.matchedReservationId);
        if (resNumber) {
          const resSnap = await db.collection('reservations')
            .where('reservationNumber', '==', resNumber)
            .limit(1)
            .get();
          if (!resSnap.empty) {
            const reservation = resSnap.docs[0].data();
            roomCode     = reservation.roomCode || '';
            checkinDate  = reservation.checkin || '';
            checkoutDate = reservation.checkout || '';
          }
        }
      }

      let memoryContext = '';
      const guestDoc = await db.collection('whatsapp_guests').doc(phone).get();
      if (guestDoc.exists) {
        const summary = guestDoc.data().summary;
        if (Array.isArray(summary) && summary.length > 0) {
          memoryContext = `\nPrevious stay notes for this guest: ${summary.map((s) => `- ${s}`).join(' ')}`;
        }
      }

      // Owner echoes map to an assistant turn prefixed "Host: " so the model knows
      // a human already responded.
      const history = [...recentNewestFirst]
        .reverse()
        .map((m) => {
          if (m.role === 'owner') return { role: 'assistant', content: `Host: ${m.content}` };
          if (m.role === 'assistant') return { role: 'assistant', content: m.content };
          return { role: 'user', content: m.content };
        });

      // CHANGE G — inject the current Tbilisi hour so the model can apply
      // hour-dependent scenarios (e.g. cleaning staff availability).
      const guestContext = [
        `Guest name: ${guestName}`,
        `Room/apartment type: ${roomCode || 'unknown'}`,
        `Check-in: ${checkinDate || 'unknown'}`,
        `Checkout: ${checkoutDate || 'unknown'}`,
        `Filled check-in form: ${hasFilledForm ? 'yes' : 'no'}`,
        `CURRENT_TBILISI_HOUR: ${tbilisiHour()}`,
      ].join('\n') + memoryContext;

      const modeContext = buildModeContext(effectiveMode, config.ownerPhone);
      const systemWithContext = `${SYSTEM_PROMPT}\n\n${guestContext}\n\n${modeContext}`;

      console.log('whatsappBotWorker: calling Claude for phone:', phone);
      let aiReply = await callClaude({ system: systemWithContext, messages: history });
      console.log('whatsappBotWorker: Claude responded, length:', (aiReply || '').length);

      let escalated = false;
      let escalationReason = 'escalation';

      if (!aiReply) {
        aiReply = 'Let me check on that and get back to you shortly.';
        escalated = true;
        escalationReason = 'unhandled_message';
      }

      // Parse an optional [VIDEO:media_id] prefix
      let videoMediaId = null;
      const videoMatch = aiReply.match(/^\[VIDEO:(\d+)\]\s*\n?/);
      if (videoMatch) {
        videoMediaId = videoMatch[1];
        aiReply = aiReply.slice(videoMatch[0].length).trim();
      }

      // ANGRY GUEST DETECTION — checked before [SILENT] since it needs its own,
      // different combination: full silence to the guest (like [SILENT]) but
      // still an immediate urgent owner alert (like [URGENT:...]), which
      // [SILENT]'s own early-return doesn't do. The model is asked to output
      // only this tag with no guest-facing text; treated as a presence test
      // regardless, same as the other tags.
      if (/\[URGENT:ANGRY\]/i.test(aiReply)) {
        console.log(`whatsappBotWorker: STOPPED — angry/complaint guest, urgent silent alert for ${phone}`);
        await writeAlert(db, {
          reason: 'angry_guest',
          phone,
          guestName,
          room: roomCode,
          message: combinedGuestText,
          mode: effectiveMode,
          urgency: true,
        });
        if (config.ownerPhone) {
          await notifyOwner(
            config.ownerPhone,
            `URGENT: ${guestName} ${roomCode || 'unknown room'} — angry/complaint guest: ${combinedGuestText.slice(0, 300)}`
          );
        }
        await deletePendingIfTokenMatches(db, phone, batchToken);
        return res.sendStatus(200);
      }

      // CHANGE 7 — [SILENT]: the model asked to send nothing (host already
      // handled it, or the topic is explicitly out of scope). Checked as a
      // presence test — any reply carrying this tag sends nothing at all,
      // even if other text is attached.
      if (isSilentAiReply(aiReply)) {
        console.log(`whatsappBotWorker: STOPPED — [SILENT] tag for ${phone}`);
        await deletePendingIfTokenMatches(db, phone, batchToken);
        return res.sendStatus(200);
      }

      // Strip trailing [ESCALATE] / [URGENT:...] tags — internal only, never sent to WhatsApp.
      // [VIDEO_SENT:id] is stripped defensively too — it's a marker WE write into stored
      // history (see below), never something the model is asked to output, but a model can
      // echo patterns it sees in its own context, so guard the guest-facing send anyway.
      const hasEscalateTag = /\[ESCALATE\]/i.test(aiReply);
      const urgentMatch = aiReply.match(/\[URGENT:(LOCKOUT|ISSUE)\]/i);
      aiReply = aiReply
        .replace(/\s*\[ESCALATE\]\s*/gi, ' ')
        .replace(/\s*\[URGENT:(?:LOCKOUT|ISSUE)\]\s*/gi, ' ')
        .replace(/\s*\[VIDEO_SENT:\d+\]\s*/gi, ' ')
        .replace(/\s+$/, '')
        .trim();
      if (hasEscalateTag) {
        escalated = true;
        escalationReason = 'escalation';
      }

      // CHANGE C — urgent issues (lockout, flooding/security) page the owner
      // immediately, regardless of bot mode or time of day — ahead of the
      // humanizer delay and the guest-facing send.
      let urgencyFlag = false;
      if (urgentMatch) {
        urgencyFlag = true;
        escalated = true;
        escalationReason = 'escalation';
        const urgentMessage = urgentMatch[1].toUpperCase() === 'LOCKOUT'
          ? `URGENT: ${guestName} ${roomCode || 'unknown room'} — guest is locked out`
          : `URGENT: ${guestName} ${roomCode || 'unknown room'} — ${combinedGuestText.slice(0, 300)}`;
        if (config.ownerPhone) {
          await notifyOwner(config.ownerPhone, urgentMessage);
        }
      }

      // Small humanizer — short, after Claude, before send. Not the batching delay.
      await sleep(1000 + Math.random() * 1000);

      // Final re-check, immediately before anything is sent. The checks above ran
      // before the Claude call (seconds ago); an owner echo that landed during
      // Claude or the sleep above would otherwise be missed and the bot would talk
      // over the host. The echo handler also deletes whatsapp_pending, so a missing
      // pending doc is a second signal.
      const pendingNow = await pendingRef.get();
      if (!pendingNow.exists || await ownerMuted()) {
        console.log('whatsappBotWorker: STOPPED — owner replied while reply was being generated (pre-send check) for', phone);
        await deletePendingIfTokenMatches(db, phone, batchToken);
        return res.sendStatus(200);
      }

      if (videoMediaId) {
        await sendWhatsAppMessage({
          messaging_product: 'whatsapp',
          to: phone,
          type: 'video',
          video: { id: videoMediaId },
        });
      }

      await sendWhatsAppMessage({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: aiReply },
      });

      // Mark in stored history (never in the guest-facing send above) that a video
      // was sent, so a later Claude call can see it and not resend the same video
      // for a follow-up question on the same topic — see FOR FOLLOW-UP QUESTIONS.
      const storedAssistantContent = videoMediaId ? `${aiReply}\n[VIDEO_SENT:${videoMediaId}]` : aiReply;
      await convoMessagesRef.add({
        role: 'assistant',
        content: storedAssistantContent,
        timestamp: FieldValue.serverTimestamp(),
      });

      if (escalated) {
        await writeAlert(db, {
          reason: escalationReason,
          phone,
          guestName,
          room: roomCode,
          message: combinedGuestText,
          mode: effectiveMode,
          urgency: urgencyFlag,
        });

        // Urgent cases already paged the owner immediately, above — avoid a
        // second, redundant notification for the same incident.
        if (config.ownerPhone && !urgencyFlag) {
          await notifyOwner(
            config.ownerPhone,
            `Guest needs help — ${guestName} / ${roomCode || 'unknown room'} / mode=${effectiveMode}: ${combinedGuestText}`
          );
        }
      }

      await deletePendingIfTokenMatches(db, phone, batchToken);

      console.log('whatsappBotWorker: completed normally for', phone);
      return res.sendStatus(200);
    } catch (err) {
      console.error('whatsappBotWorker error:', err);
      return res.sendStatus(200); // clean completion so Cloud Tasks does not retry indefinitely
    }
  }
);

exports.roomReadyNotification = onDocumentWritten(
  {
    document: 'hk_status/{docId}',
    region: 'europe-west1',
    secrets: ['META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID'],
  },
  async (event) => {
    const before = event.data.before;
    const after  = event.data.after;

    // Only fire when done flips TO true
    if (!after.exists) return;
    if (after.data().done !== true) return;
    if (before.exists && before.data().done === true) return;

    const { roomCode, date } = after.data();
    if (!roomCode || !date) return;

    const db = getFirestore();

    const snap = await db.collection('checkin_guests')
      .where('aptId', '==', roomCode)
      .where('arrivalDate', '==', date)
      .where('contactType', '==', 'wa')
      .limit(1)
      .get();

    if (snap.empty) {
      console.log(`roomReadyNotification: no WA guest for ${roomCode} / ${date}`);
      return;
    }

    const guest = snap.docs[0].data();
    const phone = normalizePhone(guest.contact);
    const name  = guest.name || 'Guest';
    const firstName = guestFirstName(name);
    const reservationNumber = baseReservationNumber(guest.matchedReservationId);

    if (!phone) {
      console.log(`roomReadyNotification: guest found but no phone for ${roomCode} / ${date}`);
      return;
    }

    if (reservationNumber && await alreadySentRoomReady(db, reservationNumber)) {
      console.log(`roomReadyNotification: already sent for reservation ${reservationNumber}`);
      return;
    }

    try {
      const data = await sendWhatsAppMessage({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: {
          name: 'room_ready',
          language: { code: 'en' },
          components: [{
            type: 'body',
            parameters: [{ type: 'text', text: firstName }],
          }],
        },
      });

      if (data.messages) {
        const metaMessageId = data.messages[0]?.id || '';
        await writeRoomReadyRecord(db, {
          reservationNumber,
          guestName: name,
          phone,
          status: 'sent',
          metaMessageId,
        });
        console.log(`roomReadyNotification: sent to ${name} (${phone}) — id=${metaMessageId}`);
      } else {
        await writeRoomReadyRecord(db, {
          reservationNumber,
          guestName: name,
          phone,
          status: 'failed',
        });
        console.error(`roomReadyNotification: Meta error for ${phone} —`, JSON.stringify(data));
      }
    } catch (err) {
      await writeRoomReadyRecord(db, {
        reservationNumber,
        guestName: name,
        phone,
        status: 'failed',
      }).catch(() => {});
      console.error(`roomReadyNotification: fetch failed for ${phone}`, err);
    }
  }
);

// PART 3 — auto-summarize a guest's WhatsApp conversation after checkout
exports.summarizeGuestConversation = onDocumentWritten(
  {
    document: 'reservations/{docId}',
    region: 'europe-west1',
    secrets: ['ANTHROPIC_API_KEY'],
  },
  async (event) => {
    const after = event.data?.after;
    if (!after || !after.exists) return;

    const reservation = after.data();

    if (reservation.status === 'CANCELLED') return;

    const checkoutDate = toJsDate(reservation.checkout);
    if (!checkoutDate) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (checkoutDate >= today) return;

    const reservationNumber = reservation.reservationNumber;
    if (!reservationNumber) return;

    const db = getFirestore();

    // Find the matching WhatsApp check-in form for this reservation.
    // matchedReservationId may be the bare number or a multi-room id like "007004653_001".
    let form = null;
    const exactSnap = await db.collection('checkin_guests')
      .where('matchedReservationId', '==', reservationNumber)
      .where('contactType', '==', 'wa')
      .limit(1)
      .get();

    if (!exactSnap.empty) {
      form = exactSnap.docs[0].data();
    } else {
      // Range query alone (no contactType) avoids needing a new composite index.
      const multiSnap = await db.collection('checkin_guests')
        .where('matchedReservationId', '>=', `${reservationNumber}_`)
        .where('matchedReservationId', '<', `${reservationNumber}_`)
        .limit(20)
        .get();
      const match = multiSnap.docs.find((d) => (d.data().contactType || '').toLowerCase() === 'wa');
      if (match) form = match.data();
    }

    if (!form) return;

    const phone = normalizePhone(form.contact);
    if (!phone) return;

    const messagesRef = db.collection('whatsapp_conversations').doc(phone).collection('messages');
    const messagesSnap = await messagesRef.orderBy('timestamp', 'asc').get();

    if (messagesSnap.empty) return;

    const conversationText = messagesSnap.docs
      .map((d) => {
        const m = d.data();
        // Strip the internal [VIDEO_SENT:id] follow-up marker — noise for the summarizer.
        const content = String(m.content || '').replace(/\s*\[VIDEO_SENT:\d+\]\s*/gi, ' ').trim();
        return `${m.role === 'assistant' ? 'Assistant' : m.role === 'owner' ? 'Host' : 'Guest'}: ${content}`;
      })
      .join('\n');

    let summaryText = '';
    try {
      summaryText = await callClaude({
        system: SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: conversationText }],
      });
    } catch (err) {
      console.error(`summarizeGuestConversation: Claude call failed for ${phone}`, err);
      return;
    }

    const summaryBullets = summaryText
      .split('\n')
      .map((line) => line.replace(/^[-•*]\s*/, '').trim())
      .filter((line) => line.length > 0);

    if (summaryBullets.length === 0) return;

    await db.collection('whatsapp_guests').doc(phone).set(
      {
        summary: summaryBullets,
        lastStay: {
          room: reservation.roomCode || '',
          checkin: reservation.checkin || '',
          checkout: reservation.checkout || '',
          reservationNumber,
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // Delete all messages from this conversation now that it's summarized
    const batch = db.batch();
    messagesSnap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    console.log(`summarizeGuestConversation: summarized ${phone} for reservation ${reservationNumber}`);
  }
);
