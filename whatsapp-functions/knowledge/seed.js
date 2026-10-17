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
      ]
    },
    "superior": {
      "description": "Superior Apartment: 1 isolated bedroom with double bed, living room with double bed divided by curtains and 2 sofas, has kitchen, fits up to 6 guests",
      "name": "Superior Apartment",
      "kitchen": true,
      "maxGuests": 6,
      "beds": [
        "bedroom: 1 double bed",
        "living room: 1 double bed (curtain) + 2 sofas"
      ]
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
      "maxBabies": 1
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
      "mapsUrl": "https://maps.app.goo.gl/MruPY7q5RB1trNCz9"
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
      "includedInPrice": false
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
    "version": "2026-10-17b",
    "note": "Seed = the facts that were in SYSTEM_PROMPT on 2026-10-17, word for word. Firestore kb_* docs (when they exist) override these by id. Text fragments used by the bot prompt are kept exactly; structured fields are for other readers (e.g. a Booking.com inbox answerer).",
    "factDecisions": "Owner decisions 2026-10-17: address and parking links checked (Shartava address = the named 35/37 place, parking = the Carrefour garage, same links as admin settings); 3-bedroom 11 guests + 1 baby; WiFi only from the check-in page data; cleaning prices 30/50/70 confirmed."
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
