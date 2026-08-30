'use strict';
/**
 * Canonical room/apartment registry — single source for adding new properties.
 * Firestore `checkin_rooms` is the runtime catalog; this module is the code default + merge source.
 *
 * To add apartments: edit DEFAULT_ROOMS_SEED here, open admin sandbox (auto-syncs missing rooms), fill WiFi in Apts tab, set HK PIN for the site in HK settings.
 * See docs/ADD_APARTMENT_GUIDE.md
 */

/** @typedef {{roomCode:string,displayName:string,displayCode:string,group:string,sortOrder:number,site:string,showInHk:boolean,minihotelNames:string[],beddingRule?:string}} RoomSeed */

export const ROOM_SITES = [
  { id: 'shartava', label: 'Shartava' },
  { id: 'centre', label: 'City Centre' },
  { id: 'vgl', label: 'VGL' },
  { id: 'abashidze', label: 'Abashidze' },
];

/** Default room list — merged into Firestore when rooms are missing. */
export const DEFAULT_ROOMS_SEED = [
  { roomCode: '0-1', displayName: 'Small Room 1', displayCode: '0-1', group: 'Shartava — 0- Rooms', sortOrder: 0, site: 'shartava', showInHk: true, minihotelNames: ['0-1'], beddingRule: '0-' },
  { roomCode: '0-2', displayName: 'Small Room 2', displayCode: '0-2', group: 'Shartava — 0- Rooms', sortOrder: 1, site: 'shartava', showInHk: true, minihotelNames: ['0-2'], beddingRule: '0-' },
  { roomCode: '0-3', displayName: 'Small Room 3', displayCode: '0-3', group: 'Shartava — 0- Rooms', sortOrder: 2, site: 'shartava', showInHk: true, minihotelNames: ['0-3'], beddingRule: '0-' },
  { roomCode: '0-4', displayName: 'Small Room 4', displayCode: '0-4', group: 'Shartava — 0- Rooms', sortOrder: 3, site: 'shartava', showInHk: true, minihotelNames: ['0-4'], beddingRule: '0-' },
  { roomCode: '0-5', displayName: 'Small Room 5', displayCode: '0-5', group: 'Shartava — 0- Rooms', sortOrder: 4, site: 'shartava', showInHk: true, minihotelNames: ['0-5'], beddingRule: '0-' },
  { roomCode: '6-1', displayName: 'Apartment 6-1', displayCode: '6-1', group: 'Shartava — 6- Apartments', sortOrder: 10, site: 'shartava', showInHk: true, minihotelNames: ['M-6-1'], beddingRule: '6-7' },
  { roomCode: '6-2', displayName: 'Apartment 6-2', displayCode: '6-2', group: 'Shartava — 6- Apartments', sortOrder: 11, site: 'shartava', showInHk: true, minihotelNames: ['M-6-2'], beddingRule: '6-7' },
  { roomCode: '6-3', displayName: 'Apartment 6-3', displayCode: '6-3', group: 'Shartava — 6- Apartments', sortOrder: 12, site: 'shartava', showInHk: true, minihotelNames: ['M-6-3'], beddingRule: '6-3' },
  { roomCode: '6-4', displayName: 'Apartment 6-4', displayCode: '6-4', group: 'Shartava — 6- Apartments', sortOrder: 13, site: 'shartava', showInHk: true, minihotelNames: ['M-6-4'], beddingRule: '6-7' },
  { roomCode: '7-1', displayName: 'Apartment 7-1', displayCode: '7-1', group: 'Shartava — 7- Apartments', sortOrder: 20, site: 'shartava', showInHk: true, minihotelNames: ['M-7-1'], beddingRule: '6-7' },
  { roomCode: '7-2', displayName: 'Apartment 7-2', displayCode: '7-2', group: 'Shartava — 7- Apartments', sortOrder: 21, site: 'shartava', showInHk: true, minihotelNames: ['M-7-2'], beddingRule: '6-7' },
  { roomCode: '7-4', displayName: 'Apartment 7-4', displayCode: '7-4', group: 'Shartava — 7- Apartments', sortOrder: 22, site: 'shartava', showInHk: true, minihotelNames: ['M-7-4'], beddingRule: '6-7' },
  { roomCode: 'orb-1', displayName: 'Orb Building, Unit 1', displayCode: 'Orb 1', group: 'City Centre — Orb', sortOrder: 30, site: 'centre', showInHk: true, minihotelNames: ['Midamo 1'], beddingRule: 'orb-tab' },
  { roomCode: 'orb-2', displayName: 'Orb Building, Unit 2', displayCode: 'Orb 2', group: 'City Centre — Orb', sortOrder: 31, site: 'centre', showInHk: true, minihotelNames: ['Midamo 2'], beddingRule: 'orb-tab' },
  { roomCode: 'orb-3', displayName: 'Orb Building, Unit 3', displayCode: 'Orb 3', group: 'City Centre — Orb', sortOrder: 32, site: 'centre', showInHk: true, minihotelNames: ['Midamo 3'], beddingRule: 'orb-tab' },
  { roomCode: 'tab-1', displayName: 'Tab Building, Unit 1', displayCode: 'Tab 1', group: 'City Centre — Tab', sortOrder: 40, site: 'centre', showInHk: true, minihotelNames: ['T-1'], beddingRule: 'orb-tab' },
  { roomCode: 'tab-2', displayName: 'Tab Building, Unit 2', displayCode: 'Tab 2', group: 'City Centre — Tab', sortOrder: 41, site: 'centre', showInHk: true, minihotelNames: ['T-2'], beddingRule: 'orb-tab' },
  { roomCode: 'tab-3', displayName: 'Tab Building, Unit 3', displayCode: 'Tab 3', group: 'City Centre — Tab', sortOrder: 42, site: 'centre', showInHk: true, minihotelNames: ['T-3'], beddingRule: 'orb-tab' },
  { roomCode: 'vgl-st1', displayName: 'VGL Studio 1', displayCode: 'vgl-st1', group: 'VGL', sortOrder: 50, site: 'vgl', showInHk: true, minihotelNames: ['VGL_ST1'], beddingRule: 'orb-tab' },
  { roomCode: 'vgl-st2', displayName: 'VGL Studio 2', displayCode: 'vgl-st2', group: 'VGL', sortOrder: 51, site: 'vgl', showInHk: true, minihotelNames: ['VGL_ST2'], beddingRule: 'orb-tab' },
  { roomCode: 'vgl-ap3', displayName: 'VGL Apartment 3', displayCode: 'vgl-ap3', group: 'VGL', sortOrder: 52, site: 'vgl', showInHk: true, minihotelNames: ['VGL_AP3'], beddingRule: '6-7' },
  { roomCode: 'vgl-ap4', displayName: 'VGL Apartment 4', displayCode: 'vgl-ap4', group: 'VGL', sortOrder: 53, site: 'vgl', showInHk: true, minihotelNames: ['VGL_AP4'], beddingRule: '6-7' },
  { roomCode: 'abashidze', displayName: 'Abashidze', displayCode: 'abashidze', group: 'Abashidze', sortOrder: 60, site: 'abashidze', showInHk: true, minihotelNames: [], beddingRule: '6-7' },
];

/** @param {Record<string, object>} roomsData */
export function roomsSorted(roomsData, activeOnly = true) {
  return Object.values(roomsData)
    .filter((r) => !activeOnly || r.active !== false)
    .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || String(a.roomCode).localeCompare(String(b.roomCode)));
}

/** Build MiniHotel name → roomCode map from seed (Python sync merges Firestore on top). */
export function buildMinihotelMap(seed = DEFAULT_ROOMS_SEED) {
  const map = {};
  for (const r of seed) {
    for (const name of r.minihotelNames || []) {
      if (name) map[name] = r.roomCode;
    }
  }
  return map;
}

export function normalizeRoomCode(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, '-');
}
