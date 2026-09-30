'use strict';
/**
 * Shared helpers for HK damage reports + ready photos (cleaner.html and checkin-admin.html).
 * Photos are ALWAYS uploaded as the original file (no canvas, no resize) so EXIF time data is kept.
 */

export const DAMAGE_CATEGORIES = ['broken', 'stain', 'missing', 'notworking', 'dirty', 'other'];
export const DAMAGE_CLAIM_DAYS = 14;
export const MAX_PHOTOS = 10;

/** Tbilisi (UTC+4, no DST) ISO string with offset, e.g. 2026-10-01T14:32:10.123+04:00 */
export function tbilisiIsoNow(now = Date.now()) {
  return new Date(now + 4 * 3600 * 1000).toISOString().replace('Z', '+04:00');
}
export function tbilisiDate(now = Date.now()) {
  return new Date(now + 4 * 3600 * 1000).toISOString().slice(0, 10);
}

/** DMG-YYYYMMDD-roomcode-XXXX */
export function makeReportId(reportDate, roomCode, rand = Math.random) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 4; i++) r += chars[Math.floor(rand() * chars.length)];
  return `DMG-${String(reportDate).replace(/-/g, '')}-${roomCode}-${r}`;
}

/* ── Minimal JPEG EXIF reader (DateTimeOriginal + OffsetTimeOriginal). Never throws. ── */
export function parseExifDate(buf) {
  try {
    const dv = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (dv.byteLength < 12 || dv.getUint16(0) !== 0xffd8) return null;
    let p = 2;
    while (p + 4 <= dv.byteLength) {
      if (dv.getUint8(p) !== 0xff) return null;
      const marker = dv.getUint8(p + 1);
      if (marker === 0xda || marker === 0xd9) return null; // image data reached, no EXIF
      const len = dv.getUint16(p + 2);
      if (marker === 0xe1 && len >= 8 && dv.getUint32(p + 4) === 0x45786966 && dv.getUint16(p + 8) === 0) {
        return readTiff(dv, p + 10, p + 2 + len);
      }
      p += 2 + len;
    }
  } catch (e) { /* tolerate broken EXIF */ }
  return null;
}
function readTiff(dv, tiff, end) {
  const le = dv.getUint16(tiff) === 0x4949;
  if (!le && dv.getUint16(tiff) !== 0x4d4d) return null;
  if (dv.getUint16(tiff + 2, le) !== 0x002a) return null;
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  const ascii = (o, n) => {
    let s = '';
    for (let i = 0; i < n; i++) { const c = dv.getUint8(o + i); if (!c) break; s += String.fromCharCode(c); }
    return s;
  };
  const readIfd = (off) => {
    const out = {};
    if (off <= 0 || tiff + off + 2 > end) return out;
    const n = u16(tiff + off);
    for (let i = 0; i < n; i++) {
      const e = tiff + off + 2 + i * 12;
      if (e + 12 > end) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (type === 2) { // ASCII
        const valOff = count <= 4 ? e + 8 : tiff + u32(e + 8);
        if (valOff + count <= end) out[tag] = ascii(valOff, count);
      } else if (type === 4 && count === 1) {
        out[tag] = u32(e + 8);
      }
    }
    return out;
  };
  const ifd0 = readIfd(u32(tiff + 4));
  const exifPtr = ifd0[0x8769];
  if (!exifPtr) return null;
  const exif = readIfd(exifPtr);
  const raw = exif[0x9003];
  const m = typeof raw === 'string' && raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m || m[1] === '0000') return null;
  const off = typeof exif[0x9011] === 'string' && /^[+-]\d{2}:\d{2}$/.test(exif[0x9011]) ? exif[0x9011] : null;
  return { dateTimeOriginal: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`, offset: off };
}

/** Everything we record about a picked file, BEFORE upload. Reads the file but never modifies it. */
export async function readPhotoMeta(file) {
  let exif = null;
  try {
    const head = await file.slice(0, 512 * 1024).arrayBuffer();
    exif = parseExifDate(head);
  } catch (e) { /* ignore */ }
  return {
    exifTakenAt: exif ? exif.dateTimeOriginal + (exif.offset || '') : null,
    exifHasOffset: !!(exif && exif.offset),
    fileLastModified: file.lastModified ? new Date(file.lastModified).toISOString() : null,
    size: file.size,
    contentType: file.type || 'application/octet-stream',
    name: file.name || '',
  };
}

export function fileExt(file) {
  const fromName = (String(file.name || '').match(/\.([A-Za-z0-9]{2,5})$/) || [])[1];
  if (fromName) return fromName.toLowerCase();
  const t = String(file.type || '');
  if (t === 'image/jpeg') return 'jpg';
  if (t === 'image/png') return 'png';
  if (t === 'image/heic') return 'heic';
  if (t === 'image/heif') return 'heif';
  if (t === 'image/webp') return 'webp';
  return 'jpg';
}

/**
 * Upload the ORIGINAL file. storageApi = { ref, uploadBytesResumable, getDownloadURL, getMetadata } (firebase-storage.js).
 * Resolves with the photo record to store in Firestore.
 */
export function uploadOriginal(storageApi, storage, file, path, meta, addedBy, onProgress, extra = {}) {
  const { ref, uploadBytesResumable, getDownloadURL, getMetadata } = storageApi;
  return new Promise((resolve, reject) => {
    const r = ref(storage, path);
    const task = uploadBytesResumable(r, file, { contentType: file.type || 'application/octet-stream' });
    task.on('state_changed',
      (s) => { if (onProgress && s.totalBytes) onProgress(s.bytesTransferred / s.totalBytes); },
      reject,
      async () => {
        try {
          const url = await getDownloadURL(task.snapshot.ref);
          let storageTimeCreated = null;
          try { storageTimeCreated = (await getMetadata(task.snapshot.ref)).timeCreated || null; } catch (e) { /* keep null */ }
          resolve({
            url, path,
            contentType: meta.contentType, size: meta.size, name: meta.name,
            exifTakenAt: meta.exifTakenAt, fileLastModified: meta.fileLastModified,
            storageTimeCreated,
            addedBy, addedAtClient: tbilisiIsoNow(),
            ...extra,
          });
        } catch (e) { reject(e); }
      });
  });
}

/* ── Guest snapshot ── */
function notCancelled(r) { return String(r.status || '').toUpperCase() !== 'CANCELLED'; }
/** Departing reservation: checkout === reportDate, else most recent checkout <= reportDate. */
export function pickDepartingReservation(reservations, roomCode, reportDate) {
  const list = (reservations || []).filter((r) => notCancelled(r) && r.roomCode === roomCode && r.checkout);
  const same = list.filter((r) => r.checkout === reportDate);
  if (same.length) return same.sort((a, b) => String(b.checkin).localeCompare(String(a.checkin)))[0];
  const before = list.filter((r) => r.checkout <= reportDate).sort((a, b) => b.checkout.localeCompare(a.checkout));
  return before[0] || null;
}

/* ── Claim deadline (dates are Tbilisi YYYY-MM-DD strings) ── */
export function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function claimDeadline(checkout) { return checkout ? addDaysStr(checkout, DAMAGE_CLAIM_DAYS) : null; }
/** Whole days from today (Tbilisi) to deadline; 0 = last day, negative = expired. */
export function daysLeft(deadline, today) {
  if (!deadline || !today) return null;
  return Math.round((Date.parse(deadline + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
}
