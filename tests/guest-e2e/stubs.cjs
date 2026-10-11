// Page-side stubs: in-memory Firestore, Storage, Functions (calls go to Node), App, and a movable clock.
exports.FS = `
const S = (window.__DB = window.__DB || {docs:{}, listeners:[], calls:[], uploads:[]});
const clone = o => o===undefined?undefined:JSON.parse(JSON.stringify(o));
const nowTs = () => ({seconds:Math.floor(Date.now()/1000), nanoseconds:0});
export const serverTimestamp = () => ({__s:'ts'});
export const arrayUnion = (...items) => ({__s:'union', items});
export const increment = n => ({__s:'inc', n});
export const getFirestore = () => ({});
const resolve = (data, old) => { const out = {}; for (const [k,v] of Object.entries(data||{})) {
  if (v && v.__s==='ts') out[k]=nowTs();
  else if (v && v.__s==='union') { const cur=Array.isArray(old&&old[k])?old[k]:[]; out[k]=[...cur, ...v.items.filter(i=>!cur.some(c=>JSON.stringify(c)===JSON.stringify(i)))]; }
  else if (v && v.__s==='inc') out[k]=((old&&old[k])||0)+v.n;
  else if (v && typeof v==='object' && !Array.isArray(v)) out[k]=resolve(v, old&&old[k]);
  else out[k]=clone(v); } return out; };
const mkRef = path => ({path, id:path.split('/').pop(), __doc:true});
export const doc = (a, ...segs) => { if (a && a.__col && segs.length===0) return mkRef(a.__col+'/auto'+Math.random().toString(36).slice(2,10)); return mkRef(segs.join('/')); };
export const collection = (db, ...segs) => ({__col:segs.join('/')});
export const where = (f, op, v) => ({t:'where', f, op, v});
export const orderBy = (f, d) => ({t:'order', f, d});
export const limit = n => ({t:'limit', n});
export const query = (c, ...cons) => ({__col:c.__col, cons});
const getv = (o, f) => f.split('.').reduce((a,k)=>a==null?undefined:a[k], o);
const ok = (d, c) => { const x=getv(d,c.f), v=c.v; switch(c.op){case '==':return x===v;case '>=':return x!==undefined&&x>=v;case '<=':return x!==undefined&&x<=v;case '>':return x!==undefined&&x>v;case '<':return x!==undefined&&x<v;case 'in':return v.includes(x);case '!=':return x!==v;default:return true;} };
const listDocs = q => { const pre=q.__col+'/'; let arr=Object.keys(S.docs).filter(k=>k.startsWith(pre)&&!k.slice(pre.length).includes('/')).map(k=>({id:k.slice(pre.length), path:k, d:S.docs[k]}));
  for (const c of (q.cons||[])) if (c.t==='where') arr=arr.filter(x=>ok(x.d,c));
  for (const c of (q.cons||[])) if (c.t==='order') arr.sort((a,b)=>{const x=getv(a.d,c.f),y=getv(b.d,c.f);return (x>y?1:x<y?-1:0)*(c.d==='desc'?-1:1);});
  for (const c of (q.cons||[])) if (c.t==='limit') arr=arr.slice(0,c.n);
  return arr; };
const dsnap = ref => ({exists:()=>ref.path in S.docs, id:ref.id, ref, data:()=>clone(S.docs[ref.path])});
const qsnap = q => { const docs=listDocs(q).map(x=>({id:x.id, ref:mkRef(x.path), data:()=>clone(x.d)})); return {docs, size:docs.length, empty:docs.length===0, forEach:f=>docs.forEach(f)}; };
export const getDoc = async ref => dsnap(ref);
export const getDocs = async q => qsnap(q);
const notify = () => setTimeout(()=>S.listeners.forEach(fire),0);
export const setDoc = async (ref, data, opts) => { S.calls.push({op:'setDoc', path:ref.path});
  if (opts && opts.merge) S.docs[ref.path] = Object.assign({}, S.docs[ref.path]||{}, resolve(data, S.docs[ref.path]||{})); else S.docs[ref.path]=resolve(data,{}); notify(); };
export const updateDoc = async (ref, upd) => { S.calls.push({op:'updateDoc', path:ref.path}); S.docs[ref.path]=Object.assign({}, S.docs[ref.path]||{}, resolve(upd, S.docs[ref.path]||{})); notify(); };
export const addDoc = async (c, data) => { const ref=doc({__col:c.__col}); S.calls.push({op:'addDoc', path:ref.path}); S.docs[ref.path]=resolve(data,{}); notify(); return ref; };
export const deleteDoc = async ref => { delete S.docs[ref.path]; notify(); };
function fire(l) { const snap = l.ref.__doc ? dsnap(l.ref) : qsnap(l.ref); const sig = JSON.stringify(l.ref.__doc ? (snap.exists()?snap.data():null) : snap.docs.map(d=>[d.id,d.data()])); if (sig===l.last) return; l.last=sig; try { l.cb(snap); } catch(e) { console.error('snapshot cb', e); } }
export const onSnapshot = (ref, cb) => { const l={ref, cb, last:null}; S.listeners.push(l); setTimeout(()=>fire(l),0); return ()=>{ S.listeners=S.listeners.filter(x=>x!==l); }; };
window.__DBAPI = { set:(p,d,m)=>{ S.docs[p]= m? Object.assign({}, S.docs[p]||{}, resolve(d,S.docs[p]||{})) : resolve(d,{}); notify(); } };
`;
exports.STORAGE = `
const S = (window.__DB = window.__DB || {docs:{}, listeners:[], calls:[], uploads:[]});
export const getStorage = () => ({});
export const ref = (st, path) => ({path});
export const uploadBytes = async (r, blob) => { S.uploads.push({path:r.path, size:blob.size, type:blob.type}); };
export const getDownloadURL = async r => 'https://storage.test/' + r.path + '?token=t';
`;
exports.FUNCTIONS = `
export const getFunctions = () => ({});
export const connectFunctionsEmulator = () => {};
export const httpsCallable = (fns, name) => async data => {
  const out = await window.__callFn(name, JSON.parse(JSON.stringify(data||{})));
  if (out && out.__error) { const e = new Error(out.__error.message); e.code = 'functions/' + out.__error.code; throw e; }
  return { data: out };
};
`;
exports.APP = `export const initializeApp = () => ({});`;
exports.CLOCK = `
(() => { const Real = Date; let off = 0;
  window.__setClock = iso => { off = new Real(iso).getTime() - Real.now(); };
  class D extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now()+off); } static now() { return Real.now()+off; } }
  window.Date = D; })();
`;
