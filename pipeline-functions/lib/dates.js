'use strict';

/**
 * Half-open stay windows [checkin, checkout). Same-day turnovers do not overlap.
 * Dates are YYYY-MM-DD strings (Tbilisi calendar).
 */
function datesOverlap(aIn, aOut, bIn, bOut) {
  if (!aIn || !aOut || !bIn || !bOut) return false;
  return aIn < bOut && bIn < aOut;
}

module.exports = { datesOverlap };
