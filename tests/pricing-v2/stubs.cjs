// Stand-ins for the Firebase web SDK: owner already signed in, Firestore in memory.
// Every write is logged in window.__FS.writes so the tests can check exactly what was written.
exports.APP = `export const initializeApp = () => ({});`;
exports.AUTH = `
export const getAuth = () => ({ currentUser: { email: 'nikavibliani@gmail.com', emailVerified: true } });
export class GoogleAuthProvider { setCustomParameters() {} }
export const signInWithPopup = async () => {}; export const signInWithRedirect = async () => {}; export const getRedirectResult = async () => null;
export const onAuthStateChanged = (auth, cb) => { setTimeout(() => cb(auth.currentUser), 0); };
export const signOut = async () => {};`;
exports.FS = `
const S = (window.__FS = window.__FS || { docs: {}, writes: [], fail: [], reads: [] });
const clone = o => (o === undefined ? undefined : structuredClone(o));
const isOp = v => v && typeof v === 'object' && v.__op;
export const getFirestore = () => ({});
export const doc = (a, ...segs) => { if (a && a.__col && segs.length === 0) return { path: a.__col + '/auto' + Math.random().toString(36).slice(2, 9) }; if (a && a.__col) return { path: a.__col + '/' + segs.join('/') }; return { path: segs.join('/') }; };
export const collection = (db, ...segs) => ({ __col: segs.join('/') });
export const orderBy = (f, d) => ({ t: 'order', f, d });
export const limit = n => ({ t: 'limit', n });
export const query = (c, ...cons) => ({ __col: c.__col, cons });
export const arrayUnion = (...items) => ({ __op: 'union', items });
export const arrayRemove = (...items) => ({ __op: 'remove', items });
const getv = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const setv = (o, p, v) => { const parts = p.split('.'); let x = o; parts.slice(0, -1).forEach(k => { if (!x[k] || typeof x[k] !== 'object' || Array.isArray(x[k])) x[k] = {}; x = x[k]; }); x[parts[parts.length - 1]] = v; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const applyVal = (cur, v) => {
  if (isOp(v)) { const arr = Array.isArray(cur) ? cur.slice() : []; if (v.__op === 'union') { v.items.forEach(i => { if (!arr.some(x => eq(x, i))) arr.push(clone(i)); }); return arr; } return arr.filter(x => !v.items.some(i => eq(x, i))); }
  return clone(v);
};
const snap = (path, data) => ({ id: path.split('/').pop(), exists: () => data !== undefined, data: () => clone(data), ref: { path } });
export const getDoc = async ref => { S.reads.push(ref.path); if (S.fail.includes(ref.path)) { const e = new Error('permission-denied (test)'); e.code = 'permission-denied'; throw e; } return snap(ref.path, S.docs[ref.path]); };
export const getDocs = async q => {
  const pre = q.__col + '/'; S.reads.push(q.__col);
  if (S.fail.includes(q.__col)) { const e = new Error('permission-denied (test)'); e.code = 'permission-denied'; throw e; }
  let arr = Object.keys(S.docs).filter(k => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map(k => ({ path: k, d: S.docs[k] }));
  for (const c of (q.cons || [])) if (c.t === 'order') arr.sort((a, b) => { const x = getv(a.d, c.f), y = getv(b.d, c.f); return (x > y ? 1 : x < y ? -1 : 0) * (c.d === 'desc' ? -1 : 1); });
  for (const c of (q.cons || [])) if (c.t === 'limit') arr = arr.slice(0, c.n);
  const docs = arr.map(x => snap(x.path, x.d));
  return { docs, empty: docs.length === 0, size: docs.length, forEach: f => docs.forEach(f) };
};
export const setDoc = async (ref, data, opts) => {
  S.writes.push({ op: 'setDoc', path: ref.path, merge: !!(opts && opts.merge), data: clone(data) });
  if (opts && opts.merge) { const cur = clone(S.docs[ref.path]) || {}; const walk = (t, s) => { for (const [k, v] of Object.entries(s)) { if (isOp(v)) t[k] = applyVal(t[k], v); else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) { t[k] = t[k] && typeof t[k] === 'object' ? t[k] : {}; walk(t[k], v); } else t[k] = clone(v); } }; walk(cur, data); S.docs[ref.path] = cur; }
  else S.docs[ref.path] = clone(data);
};
export const updateDoc = async (ref, fields) => {
  S.writes.push({ op: 'updateDoc', path: ref.path, fields: clone(fields) });
  if (!(ref.path in S.docs)) { const e = new Error('No document to update'); e.code = 'not-found'; throw e; }
  const cur = clone(S.docs[ref.path]);
  for (const [k, v] of Object.entries(fields)) setv(cur, k, applyVal(getv(cur, k), v));
  S.docs[ref.path] = cur;
};`;
