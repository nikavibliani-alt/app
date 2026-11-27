'use strict';

// Knowledge base seed (2026-10-17). Generated from the facts in the
// WhatsApp bot's SYSTEM_PROMPT, word for word; see KNOWLEDGE_BASE.md.
// Firestore kb_* docs, once they exist, override these values by id.
// Never put door or smart lock codes here (the bag storage code is the only
// code guests may get).

module.exports = {
  "unitTypes": {
    "triple": {
      "description": "Triple Room with Private Bathroom: no kitchen, no balcony, 1 single bed, 1 double bed, 1 sofa bed, fits up to 4 guests",
      "name": "Triple Room with Private Bathroom",
      "kitchen": false,
      "balcony": false,
      "maxGuests": 4,
      "beds": [
        "1 single bed",
        "1 double bed",
        "1 sofa bed"
      ],
      "layout": {
        "en": "It has a private bathroom, a double bed, a single bed and a sofa bed, and fits up to 4 guests."
      },
      "expediaName": "Deluxe Room City View",
      "amenities": {
        "en": "Triple Room (Deluxe Room City View on Expedia): fridge, kettle and microwave (no stove, no kitchen); TV with Silknet channels; bidet; no balcony; no washing machine (guests can order our paid laundry service, see LAUNDRY). One iron and ironing board are shared by the Triple Rooms, in their hallway: after use, the guest puts them back in the hallway. The Triple Rooms' entrance is on the first floor, so no elevator is needed; their windows, on the other side of the building, are on the 3rd floor."
      },
      "washingMachine": false,
      "tv": "silknet",
      "bidet": true
    },
    "superior": {
      "description": "Superior Apartment: two rooms in total: a separate bedroom with a double bed, and a second double bed in the living room, divided by curtains (plus 2 sofas), has kitchen, fits up to 6 guests",
      "name": "Superior Apartment",
      "kitchen": true,
      "maxGuests": 6,
      "beds": [
        "bedroom: 1 double bed",
        "living room: 1 double bed (curtain) + 2 sofas"
      ],
      "layout": {
        "en": "It has two rooms in total: a separate bedroom with a double bed, and a second double bed in the living room, divided by curtains. It has a kitchen and fits up to 6 guests."
      },
      "rooms": 2,
      "amenities": {
        "en": "Superior Apartment: washing machine and drying rack; full kitchen with an electric stove, pots, pans, plates, cutlery and a kettle (no dishwasher); iron and ironing board; balcony; smart TV (no TV channels); every Superior Apartment but one has a bidet."
      },
      "variants": {
        "en": "We have 6 Superior Apartments in 3 designs, all the same size. The apartment is assigned on the check-in day, so a guest can't choose a specific apartment or number. Never say which apartments have a city view or a better view.",
        "reply": "We have 6 Superior Apartments, all the same size, in 3 different designs. The apartment is assigned on the check-in day, so a specific one can't be chosen in advance."
      },
      "washingMachine": true,
      "balcony": true,
      "tv": "smart"
    },
    "threeBedroom": {
      "description": "3 Bedroom Apartment: Bedroom 1 has 2 double beds, Bedroom 2 has 1 double bed and 1 baby bed, Bedroom 3 has 1 double bed, living room has 3 sofa beds, 1 separate toilet, 2 bathrooms with showers, has kitchen, fits up to 11 guests plus 1 baby in the baby bed",
      "name": "3 Bedroom Apartment",
      "kitchen": true,
      "maxGuests": 11,
      "beds": [
        "bedroom 1: 2 double beds",
        "bedroom 2: 1 double bed + 1 baby bed",
        "bedroom 3: 1 double bed",
        "living room: 3 sofa beds"
      ],
      "bathrooms": "2 bathrooms with showers + 1 separate toilet",
      "maxBabies": 1,
      "amenities": {
        "en": "3 Bedroom Apartment: washing machine and drying rack; full kitchen with an electric stove, pots, pans, plates, cutlery and a kettle (no dishwasher); iron and ironing board; balcony; smart TV (no TV channels); bidets in the toilets."
      },
      "washingMachine": true,
      "balcony": true,
      "tv": "smart"
    }
  },
  "policies": {
    "access": {
      "facts": "There is no key box or lock box at any of our properties. Keys are inside the apartment."
    },
    "earlyCheckin": {
      "reply": {
        "en": "Unfortunately I can't guarantee that. Check-in starts at 3pm, and if the room is ready sooner I'll text you.",
        "ka": "სამწუხაროდ ვერ მოგცემთ გარანტიას. რეზერვაცია იწყება 15:00 საათიდან, თუ ნომერი დალაგდება უფრო ადრე, მოგწერთ აუცილებლად."
      },
      "appliesTo": [
        "shartava"
      ],
      "decision": "owner"
    },
    "parking": {
      "reply": {
        "en": "We do not have private parking, but there is paid parking in the neighboring building, underneath Carrefour. Daily rate is 15 GEL, cash only. Location: https://maps.app.goo.gl/MruPY7q5RB1trNCz9"
      },
      "referenceKa": "სამწუხაროდ ჩვენი პარკინგი არ გვაქვს, მაგრამ ახლოს არის ფასიანი პარკინგი, დღეში 15 ლარი.",
      "mediaId": "975338858914982",
      "appliesTo": [
        "shartava"
      ],
      "privateParking": false,
      "nearby": "paid parking in the neighboring building, underneath Carrefour",
      "pricePerDay": 15,
      "currency": "GEL",
      "cashOnly": true,
      "mapsUrl": "https://maps.app.goo.gl/MruPY7q5RB1trNCz9",
      "behindBuilding": {
        "reply": {
          "en": "Unfortunately the parking behind the building is for the residents only. We don't have a key for it, and the spaces are very limited, so we can't offer it to guests. The nearest option is the paid parking under Carrefour.",
          "ka": "სამწუხაროდ, შენობის უკან არსებული პარკინგი მხოლოდ მაცხოვრებლებისთვისაა. გასაღები არ გვაქვს და ადგილები ძალიან შეზღუდულია, ამიტომ სტუმრებს ვერ ვთავაზობთ. ახლოს არის ფასიანი პარკინგი Carrefour-ის ქვეშ."
        },
        "insist": {
          "en": "I understand. There are only about 30 spaces there for around 400 families living in the building, so it isn't possible for us to offer it.",
          "ka": "გასაგებია, თუმცა იქ დაახლოებით 30 ადგილია 400-მდე ოჯახზე, ამიტომ ვერ ვთავაზობთ."
        },
        "residentsOnly": true,
        "key": false,
        "spaces": 30,
        "families": 400
      }
    },
    "hotWater": {
      "reply": {
        "en": "For hot water, press the button on the right handle and turn it down, towards you. The left handle controls the water pressure: press its button and pull it up, towards the wall, all the way for full pressure. Without pressing the buttons, the handles stay locked.",
        "ka": "ცხელი წყლისთვის დააჭირეთ მარჯვენა სახელურის ღილაკს და დაატრიალეთ ქვემოთ, თქვენკენ. მარცხენა სახელური წყლის წნევას არეგულირებს: დააჭირეთ ღილაკს და აწიეთ ზემოთ, კედლისკენ, ბოლომდე. ღილაკების დაჭერის გარეშე სახელურები დაბლოკილია."
      },
      "mediaId": "1819258012553462",
      "appliesTo": [
        "shartava"
      ]
    },
    "gas": {
      "facts": "There is no gas supply inside any apartment — gas exists only on balconies."
    },
    "bagStorage": {
      "reply": {
        "en": "You can leave your bags before check-in. Go to the entrance in the first photo, then the glass door in the second photo. The smart lock code is 13 24 13#. Please leave your bags under the camera, and keep passports, laptops and other valuables with you.",
        "ka": "ბარგის დატოვება check-in-მდე შეგიძლიათ. მიდით პირველ ფოტოზე ნაჩვენებ შესასვლელთან, შემდეგ კი მეორე ფოტოზე ნაჩვენებ შუშის კართან. კარის კოდია 13 24 13#. გთხოვთ, ბარგი დატოვოთ კამერის ქვეშ, ხოლო პასპორტები, ლეპტოპები და სხვა ძვირფასი ნივთები თან იქონიოთ."
      },
      "followUpFacts": "the bags stay inside the building, in the hallway behind the glass door (not outside on the street), under the camera. There is no lockable storage.",
      "afterCheckout": {
        "en": "You can leave your bags after checkout too. Go to the entrance in the first photo, then the glass door in the second photo. The smart lock code is 13 24 13#. Please leave your bags under the camera, and keep passports, laptops and other valuables with you.",
        "apartmentNote": "This is the Triple Rooms' entrance, a different entrance from your apartment's."
      },
      "mediaId": "1804812277340997",
      "appliesTo": [
        "shartava"
      ],
      "code": "13 24 13#",
      "where": "inside the building, hallway behind the glass door, under the camera",
      "lockable": false
    },
    "booking": {
      "reply": {
        "en": "Unfortunately we cannot see exact pricing or availability from our side. Reservations are only through Booking.com or Expedia. Do you need a unit with a kitchen or without?"
      },
      "link": "https://www.booking.com/Share-4xInYf",
      "noDirect": {
        "en": "We don't take direct bookings, sorry, reservations and payment are only through Booking.com or Expedia."
      },
      "appliesTo": [
        "all"
      ],
      "channels": [
        "Booking.com",
        "Expedia"
      ],
      "directBookings": false
    },
    "gym": {
      "reply": {
        "en": "We do not have a gym on site."
      },
      "appliesTo": [
        "shartava"
      ],
      "available": false
    },
    "airportTransfer": {
      "reply": {
        "en": "Yes, you can find the airport transfer option on your check-in page under Services, it will connect you directly with our driver."
      },
      "appliesTo": [
        "shartava"
      ],
      "where": "check-in page, Services"
    },
    "wifi": {
      "source": "checkin_apartments wifiName / wifiPass (the check-in page data), per unit; several units share one network (e.g. 7-1, 7-2 and 7-4), so there is no pattern",
      "appliesTo": [
        "shartava"
      ]
    },
    "smoking": {
      "triple": {
        "en": "Smoking is strictly forbidden in the Triple Room and all shared areas."
      },
      "apartment": {
        "en": "Smoking is only allowed on the balcony."
      },
      "appliesTo": [
        "shartava"
      ]
    },
    "cleaning": {
      "reply": {
        "en": "Daily cleaning is not included in your reservation price. It is available as an optional paid service. You can arrange it on the guest page:"
      },
      "prices": {
        "en": "Room 30 GEL, Apartment 50 GEL, 3 Bedroom Apartment 70 GEL.",
        "room": 30,
        "apartment": 50,
        "threeBedroom": 70,
        "currency": "GEL"
      },
      "staffHours": {
        "from": "between 10 and 19",
        "outside": "outside 10-19",
        "start": 10,
        "end": 19
      },
      "appliesTo": [
        "shartava"
      ],
      "includedInPrice": false,
      "guestOut": {
        "en": "The guest must be out of the apartment during the cleaning."
      }
    },
    "amenities": {
      "en": "Every unit: hair dryer; shower gel, shampoo and soap (we refill them on request); radiators and an air conditioner that also heats (the AC remote is in the room). Heating and hot water come from the same boiler. A baby bed can be brought to any unit for free on request. Some units have blackout curtains and some don't, so never promise one. We have no slippers, no plug adapters (guests need their own), no extra beds and no dishwasher.",
      "appliesTo": [
        "shartava"
      ],
      "slippers": false,
      "plugAdapters": false,
      "extraBeds": false,
      "babyBed": "free on request"
    },
    "tv": {
      "en": "Smart TV (Superior and 3 Bedroom Apartments): turn the TV on with the TV remote, switch it to the HDMI input, then use the second remote, for the smart TV stick. Triple Rooms have Silknet TV channels instead.",
      "appliesTo": [
        "shartava"
      ]
    },
    "laundry": {
      "en": "Triple Room guests can order our paid laundry service on the guest page, priced per item there: we collect it at the time they choose and bring it back the same day. We don't wash socks or underwear. Apartments have a washing machine; detergent is not provided, but on request we can bring some until 18:00.",
      "appliesTo": [
        "shartava"
      ],
      "returnedSameDay": true,
      "socksUnderwear": false,
      "detergentProvided": false,
      "detergentOnRequestUntil": "18:00"
    },
    "longStay": {
      "en": "Back-to-back bookings in the same unit are one stay: we don't clean between them, and nights are counted over the whole stay. For a stay of more than 5 nights, the team checks and arranges a cleaning or a towel change on request. For a stay of 5 nights or less, cleaning is our paid service on the guest page and a towel change during the stay is not included.",
      "appliesTo": [
        "shartava"
      ],
      "overNights": "5",
      "decided": "Owner, 25 Nov 2026 (replaces the free change every 7 nights)"
    },
    "houseRules": {
      "en": "Quiet hours are 22:00 to 08:00. Visitors are welcome during the day but can't stay overnight. Parties are not allowed. Children are welcome.",
      "appliesTo": [
        "shartava"
      ],
      "quietHours": "22:00-08:00",
      "visitors": "daytime only",
      "parties": false
    },
    "entrance": {
      "en": "The QR code on the guest's check-in page opens the street entrance and the elevator. It changes every 24 hours, so the guest always uses the current one on the page (a screenshot stops working). There is no magnet card. Check-in starts at 15:00 on the check-in day; from then on it is self check-in at any hour, so a late arrival, even in the early hours of the next day, is fine. An arrival before 15:00 on the check-in day is an early check-in. A lost key costs 30 GEL.",
      "appliesTo": [
        "shartava"
      ],
      "qrChangesHours": 24,
      "magnetCard": false,
      "lostKeyFee": 30
    },
    "extraGuests": {
      "reply": {
        "en": "That's no problem, thank you for letting us know. We'll prepare extra bed sheets."
      },
      "noticeBy": "the day before, or by 18:00 on the check-in day",
      "appliesTo": [
        "shartava"
      ]
    },
    "rebooking": {
      "reply": {
        "en": "Before check-in, you can rebook on the same platform you booked on. Or you can keep your current booking and pay for the change in cash when you arrive. Let me check availability and get back to you shortly."
      },
      "appliesTo": [
        "shartava"
      ]
    },
    "proofOfStay": {
      "reply": {
        "en": "Of course, we'll send it to you shortly."
      },
      "appliesTo": [
        "shartava"
      ]
    },
    "notOffered": {
      "en": "We don't offer travel insurance, and we have no city tour at the moment.",
      "appliesTo": [
        "shartava"
      ],
      "travelInsurance": false,
      "cityTour": false
    },
    "trash": {
      "reply": {
        "en": "The trash bins are in front of the building, on the left side. You can throw everything in together, at any time.",
        "ka": "ნაგვის ურნები შენობის წინ, მარცხენა მხარესაა. ყველაფერი შეგიძლიათ ერთად გადაყაროთ, ნებისმიერ დროს."
      },
      "binsLocation": "in front of the building, on the left side",
      "bins": 4,
      "beforeCheckout": {
        "en": "Yes, please take the trash out to the bins before you leave. They are in front of the building, on the left side (4 bins)."
      },
      "sorting": false,
      "anyTime": true,
      "appliesTo": [
        "shartava"
      ]
    },
    "checkin": {
      "timeKa": "სტანდარტული check-in 15:00 საათიდან არის შესაძლებელი.",
      "doorCodeTimingKa": "ინსტრუქციები 3 საათიდან იქნება ხელმისაწვდომი. თუ უფრო მალე დალაგდება ნომერი, 3 საათამდე შეგეძლებათ შესვლა.",
      "appliesTo": [
        "shartava"
      ],
      "time": "15:00",
      "earlyIsOwnerDecision": true
    },
    "checkout": {
      "timeKa": "checkout არის 12:00 საათამდე.",
      "appliesTo": [
        "shartava"
      ],
      "time": "12:00",
      "lateIsOwnerDecision": true
    },
    "pets": {
      "referenceKa": "სამწუხაროდ ცხოველების დაშვება არ არის შესაძლებელი.",
      "appliesTo": [
        "shartava"
      ],
      "allowed": false
    },
    "lateCheckout": {
      "appliesTo": [
        "shartava"
      ],
      "decision": "owner (escalate)"
    }
  },
  "properties": {
    "shartava": {
      "nearby": {
        "pharmacyKa": "აფთიაქი ქუჩაშია ხელ მარჯვნივ.",
        "shopKa": "მაღაზიები არის მარჯვნივ ქუჩაზე."
      },
      "addressLine": "Zhiuli Shartava 35/37, near Clean House Market (https://maps.app.goo.gl/fSW3iLsu4MxghzGRA)",
      "entrance": {
        "apartments": "it's the 4th entrance",
        "rooms": "your door is separate, right by the 4th entrance"
      },
      "checkinPageUrl": "app.maxelaapartments.com/checkin-guest",
      "name": "Shartava (Maxela Apartments)",
      "roomPrefixes": [
        "0-",
        "6-",
        "7-"
      ],
      "botAnswers": true,
      "address": "Zhiuli Shartava 35/37",
      "landmark": "near Clean House Market",
      "mapsUrl": "https://maps.app.goo.gl/fSW3iLsu4MxghzGRA",
      "checkInTime": "15:00",
      "checkOutTime": "12:00"
    },
    "freedom_square": {
      "name": "Freedom Square (Tabidze)",
      "roomPrefixes": [
        "tab-"
      ],
      "botAnswers": false,
      "address": "Galaktion Tabidze St. 3/5, Tbilisi",
      "mapsUrl": "https://maps.app.goo.gl/aTZpXbTnLKDkAN8e6",
      "checkInTime": "15:00",
      "checkOutTime": "12:00",
      "source": "checkin_admin/config.locationInfo + checkin_apartments (2026-10-17)"
    },
    "orbeliani": {
      "name": "Orbeliani (Midamo)",
      "roomPrefixes": [
        "orb-"
      ],
      "botAnswers": false,
      "checkInTime": "15:00",
      "checkOutTime": "12:00",
      "source": "checkin_apartments (2026-10-17); no address in admin settings"
    },
    "vgl": {
      "name": "VGL",
      "roomPrefixes": [
        "vgl-"
      ],
      "botAnswers": false,
      "source": "checkin_admin/config.locationInfo (only a name, \"VGL Group\")"
    },
    "xcv": {
      "name": "XCV (Modern Avlabari)",
      "roomPrefixes": [
        "xcv-"
      ],
      "botAnswers": false,
      "address": "24 Ketevan Tsamebuli Ave, Tbilisi 0103",
      "mapsUrl": "https://maps.app.goo.gl/oSK4CthLCaDmaxocA",
      "checkInTime": "15:00",
      "checkOutTime": "12:00",
      "source": "checkin_admin/config.locationInfo + checkin_apartments (2026-10-17)"
    },
    "abashidze": {
      "name": "Abashidze",
      "roomPrefixes": [
        "abashidze"
      ],
      "botAnswers": false,
      "source": "SleepyPMS (Airbnb iCal listing)"
    }
  },
  "_meta": {
    "status": "draft",
    "version": "2026-10-18",
    "note": "Seed = the facts that were in SYSTEM_PROMPT on 2026-10-17, word for word. Firestore kb_* docs (when they exist) override these by id. Text fragments used by the bot prompt are kept exactly; structured fields are for other readers (e.g. a Booking.com inbox answerer).",
    "factDecisions": "Owner decisions 2026-10-17: address and parking links checked (Shartava address = the named 35/37 place, parking = the Carrefour garage, same links as admin settings); 3-bedroom 11 guests + 1 baby; WiFi only from the check-in page data; cleaning prices 30/50/70 confirmed. 2026-10-18: Superior Apartment described as two rooms in total (owner wording); parking behind the building is residents only (no key, about 30 spaces for about 400 families)."
  },
  "units": {
    "0-1": {
      "property": "shartava",
      "type": "triple",
      "displayName": "Small Room 1"
    },
    "0-2": {
      "property": "shartava",
      "type": "triple",
      "displayName": "Small Room 2"
    },
    "0-3": {
      "property": "shartava",
      "type": "triple",
      "displayName": "Small Room 3"
    },
    "0-4": {
      "property": "shartava",
      "type": "triple",
      "displayName": "Small Room 4"
    },
    "0-5": {
      "property": "shartava",
      "type": "triple",
      "displayName": "Small Room 5"
    },
    "6-1": {
      "property": "shartava",
      "type": "superior",
      "displayName": "Apartment 6-1"
    },
    "6-2": {
      "property": "shartava",
      "type": "superior",
      "displayName": "Apartment 6-2"
    },
    "6-3": {
      "property": "shartava",
      "type": "threeBedroom",
      "displayName": "Apartment 6-3"
    },
    "6-4": {
      "property": "shartava",
      "type": "superior",
      "displayName": "Apartment 6-4"
    },
    "7-1": {
      "property": "shartava",
      "type": "superior",
      "displayName": "Apartment 7-1"
    },
    "7-2": {
      "property": "shartava",
      "type": "superior",
      "displayName": "Apartment 7-2"
    },
    "7-4": {
      "property": "shartava",
      "type": "superior",
      "displayName": "Apartment 7-4"
    },
    "tab-1": {
      "property": "freedom_square"
    },
    "tab-2": {
      "property": "freedom_square"
    },
    "tab-3": {
      "property": "freedom_square"
    },
    "orb-1": {
      "property": "orbeliani"
    },
    "orb-2": {
      "property": "orbeliani"
    },
    "orb-3": {
      "property": "orbeliani"
    },
    "vgl-st1": {
      "property": "vgl"
    },
    "vgl-st2": {
      "property": "vgl"
    },
    "vgl-ap3": {
      "property": "vgl"
    },
    "vgl-ap4": {
      "property": "vgl"
    },
    "xcv-1": {
      "property": "xcv"
    },
    "xcv-2": {
      "property": "xcv"
    },
    "abashidze": {
      "property": "abashidze"
    }
  },
  "media": {
    "note": "Sent by permanent link, never by Meta media id (those expire). The bot maps policies.*.mediaId tags to these files in videos.js.",
    "bagStorage": [
      "https://res.cloudinary.com/dlkjizhya/image/upload/v1792196074/maxela/info/bag-storage-1-building.jpg",
      "https://res.cloudinary.com/dlkjizhya/image/upload/v1792196075/maxela/info/bag-storage-2-glass-door.jpg"
    ],
    "parking": [
      "https://res.cloudinary.com/dlkjizhya/video/upload/v1792196077/maxela/info/parking.mp4"
    ],
    "hotWater": []
  }
};
