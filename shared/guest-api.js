'use strict';
/**
 * Client for the guest functions (guestFind, guestStay, guestScan).
 * They replace what the guest page used to read straight from Firestore.
 */

/** Switch: ?api=1 forces it on, ?api=0 forces it off, otherwise `defaultOn` (flipped when the functions are live). */
export function guestApiEnabled(search, defaultOn) {
  const v = new URLSearchParams(search || '').get('api');
  if (v === '1') return true;
  if (v === '0') return false;
  return !!defaultOn;
}

export function createGuestApi(functions, httpsCallable) {
  const find = httpsCallable(functions, 'guestFind');
  const stay = httpsCallable(functions, 'guestStay');
  const scan = httpsCallable(functions, 'guestScan');
  const call = async (fn, payload) => {
    const { data } = await fn(payload);
    if (!data || data.ok === false) {
      const e = new Error((data && data.message) || 'Request failed');
      e.code = (data && data.errorCode) || 'FAILED';
      throw e;
    }
    return data;
  };
  return {
    findBooking: p => call(find, { mode: 'find', ...p }),
    existingGuest: p => call(find, { mode: 'existing', ...p }),
    siblings: p => call(find, { mode: 'siblings', ...p }),
    companion: p => call(find, { mode: 'companion', ...p }),
    stay: p => call(stay, p || {}),
    scanPassport: p => call(scan, p),
  };
}
