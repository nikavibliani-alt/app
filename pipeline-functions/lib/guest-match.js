'use strict';
/**
 * GENERATED from checkin-guest.html by scripts/sync-guest-match.js. Do not edit by hand.
 * The page's booking-matching code, copied as-is so the server and the page agree.
 */

const _AR={
  'ا':'a','أ':'a','إ':'i','آ':'a','ب':'b','ت':'t','ث':'th','ج':'j','ح':'h',
  'خ':'kh','د':'d','ذ':'dh','ر':'r','ز':'z','س':'s','ش':'sh','ص':'s','ض':'d',
  'ط':'t','ظ':'z','ع':'a','غ':'gh','ف':'f','ق':'q','ك':'k','ل':'l','م':'m',
  'ن':'n','ه':'h','و':'w','ي':'y','ى':'a','ة':'h','ئ':'y','ؤ':'w','ء':'',
  'ً':'','ٌ':'','ٍ':'','َ':'','ُ':'','ِ':'',
  'ّ':'','ْ':''
};
function reservationBaseNum(ref){
  if(!ref)return '';
  return String(ref).trim().replace(/_\d+$/,'');
}
function levenshtein(a,b){
  const m=[];
  for(let i=0;i<=b.length;i++)m[i]=[i];
  for(let j=0;j<=a.length;j++)m[0][j]=j;
  for(let i=1;i<=b.length;i++){
    for(let j=1;j<=a.length;j++){
      m[i][j]=b.charAt(i-1)===a.charAt(j-1)?m[i-1][j-1]:Math.min(m[i-1][j-1]+1,m[i][j-1]+1,m[i-1][j]+1);
    }
  }
  return m[b.length][a.length];
}
function normalizePhone(p){return(p||'').replace(/\D/g,'').slice(-7);}
function _nameWords(s){return(s||'').toLowerCase().trim().split(/[\s,.\-]+/).filter(w=>w.length>2);}
function _translit(s){return(s||'').split('').map(c=>_AR[c]!==undefined?_AR[c]:c).join('');}
function isArabic(s){return/[؀-ۿ]/.test(s||'');}
function _csk(s){return s.replace(/[aeiouy]/g,'');}
function _normRef(s){return String(s||'').replace(/[\s\-.,#]/g,'').toUpperCase();}
function _looksLikeBookingRef(name){return /^[A-Z0-9]{8,}$/.test(_normRef(name));}
function scoreReservations(name,arrival,pool){
  const allScored=[];
  let best=null,bestScore=0;
  const isRef=_looksLikeBookingRef(name),ref=_normRef(name);
  for(const r of pool){
    if((r.status||'').toUpperCase()==='CANCELLED')continue;
    const ci=r.checkin||r.checkIn||'';
    if(!ci)continue;
    let score=0;
    if(isRef&&_normRef(r.bookingId)===ref)score=10;   // exact match: a wrong arrival date does not block it
    if(score<10){
      const isAr=isArabic(name);
      const nm=nameMatch(name,r.guest||r.guestName||'');
      const dateOk=!!(arrival&&arrival===ci);
      const partial=partialNameMatch(name,r.guest||r.guestName||'');
      if(nm&&dateOk)score=3;
      else if(nm)score=2;
      // Arabic: single-word consonant match + correct date is strong enough signal
      else if(dateOk&&partial)score=isAr?3:2;
    }
    if(score>bestScore){bestScore=score;best=r;}
    allScored.push({guest:r.guest||r.guestName||'',room:r.roomCode||'',checkin:ci,score});
  }
  // Short names only (booking name has 0 or 1 words of 3+ letters, e.g. "Hs X"): normal matching can never score 3.
  // Accept when every word of the booking name matches the typed name's words/initials, the arrival date is exact,
  // and exactly ONE booking (by base reservation number) qualifies that day. Otherwise no match.
  if(bestScore<3&&arrival){
    const cands=pool.filter(r=>(r.status||'').toUpperCase()!=='CANCELLED'&&(r.checkin||r.checkIn||'')===arrival&&_isShortNameBooking(r.guest||r.guestName||'')&&_shortNameMatches(name,r.guest||r.guestName||''));
    const bases=new Set(cands.map(r=>reservationBaseNum(r.reservationNumber||r.id)));
    if(bases.size===1){
      cands.sort((a,b)=>String(a.roomCode||'').localeCompare(String(b.roomCode||'')));
      best=cands[0];bestScore=3;
    }
  }
  return{allScored,best,bestScore};
}
function _allWords(s){return(s||'').toLowerCase().trim().split(/[\s,.\-]+/).filter(Boolean);}
function _isShortNameBooking(g){return _nameWords(g).length<=1;}
function _shortNameMatches(input,g){
  const bw=_allWords(g),tw=_allWords(input);
  if(!bw.length||!tw.length)return false;
  const ini=tw.map(w=>w[0]).join('');
  return bw.every(b=>{
    if(b.length<=2)return tw.some(t=>t===b||t.startsWith(b))||ini===b;   // short word: same word, start of a typed word, or the typed initials
    return tw.some(t=>t.length>2&&(levenshtein(t,b)<=2||t.includes(b)||b.includes(t)));
  });
}
function nameMatch(input,resGuest){
  const iw=_nameWords(input),rw=_nameWords(resGuest);
  if(!iw.length||!rw.length)return false;
  // Fuzzy token match (levenshtein ≤2), also tries reversed token order for last-name-first input
  function _wMatch(words){let m=0;for(const a of words){if(rw.some(b=>levenshtein(a,b)<=2||b.includes(a)||a.includes(b))){m++;if(m>=2)return true;}}return false;}
  if(_wMatch(iw))return true;
  if(iw.length>1&&_wMatch([...iw].reverse()))return true;
  // Arabic: transliterate → compare consonant skeletons to handle missing short vowels
  if(isArabic(input)){
    const tw=_nameWords(_translit(input));
    let tm=0;
    for(const a of tw){
      const ac=_csk(a);
      if(ac.length>=2&&rw.some(b=>{const bc=_csk(b);return bc.length>=2&&(ac===bc||levenshtein(ac,bc)<=1);})){
        tm++;if(tm>=2)return true;
      }
    }
  }
  return false;
}
function partialNameMatch(input,resGuest){
  const iw=_nameWords(input),rw=_nameWords(resGuest);
  if(iw.some(a=>rw.some(b=>levenshtein(a,b)<=2||b.includes(a)||a.includes(b))))return true;
  if(iw.length>1&&[...iw].reverse().some(a=>rw.some(b=>levenshtein(a,b)<=2||b.includes(a)||a.includes(b))))return true;
  if(isArabic(input)){
    const tw=_nameWords(_translit(input));
    if(tw.some(a=>{const ac=_csk(a);return ac.length>=2&&rw.some(b=>{const bc=_csk(b);return bc.length>=2&&(ac===bc||levenshtein(ac,bc)<=1);});}))return true;
  }
  return false;
}
function _stripRoomNum(s){return(s||'').replace(/\s+0\d+\s+/,' ').replace(/\s+/g,' ').trim();}
function _relatedBookings(best,pool){
  if(!best)return [];
  const nm=_stripRoomNum(best.guest||best.guestName||'').toLowerCase();
  if(!nm)return [];
  const ci=best.checkin||best.checkIn||'';
  if(!ci)return [];
  const ph=normalizePhone(best.phone||'');
  const bb=reservationBaseNum(best.reservationNumber||best.id);
  return pool.filter(r=>{
    if((r.status||'').toUpperCase()==='CANCELLED')return false;
    if(reservationBaseNum(r.reservationNumber||r.id)===bb)return false;
    if((r.checkin||r.checkIn||'')!==ci)return false;
    if(_stripRoomNum(r.guest||r.guestName||'').toLowerCase()!==nm)return false;
    const rp=normalizePhone(r.phone||'');
    return !ph||!rp||rp===ph;
  });
}
function _elevatorUpdatedMs(data){
  if(!data)return 0;
  const u=data.updatedAt;
  if(u?.seconds)return u.seconds*1000;
  if(typeof u==='number')return u>1e12?u:u*1000;
  if(typeof u==='string'){
    const n=parseInt(u,10);
    if(n>0)return n>1e12?n:n*1000;
  }
  return 0;
}
function _buildElevatorMerged(rtdbData,fsData){
  const rtdbTs=rtdbData?parseInt(rtdbData.updatedAt||0,10):0;
  const fsTs=fsData?_elevatorUpdatedMs(fsData):0;
  if(rtdbData&&rtdbTs>=fsTs){
    const code=String(rtdbData.display_code||rtdbData.code||'').trim();
    const qr=String(rtdbData.qr_code||'').trim();
    return{code,display_code:code,qr_code:qr,qrCode:qr,updatedAt:{seconds:Math.floor(rtdbTs/1000)},source:rtdbData.source||'auto',_source:'rtdb'};
  }
  if(fsData){
    const code=String(fsData.display_code||fsData.code||fsData.lastCode||'').trim();
    const qr=String(fsData.qr_code||fsData.qrCode||rtdbData?.qr_code||'').trim();
    const ms=_elevatorUpdatedMs(fsData);
    return{...fsData,code,display_code:code,qr_code:qr,qrCode:qr,updatedAt:ms?{seconds:Math.floor(ms/1000)}:fsData.updatedAt,_source:'firestore'};
  }
  if(rtdbData){
    const code=String(rtdbData.display_code||rtdbData.code||'').trim();
    const qr=String(rtdbData.qr_code||'').trim();
    return{code,display_code:code,qr_code:qr,qrCode:qr,updatedAt:{seconds:Math.floor(rtdbTs/1000)},source:rtdbData.source||'auto',_source:'rtdb'};
  }
  return null;
}

module.exports = {
  reservationBaseNum,
  levenshtein,
  normalizePhone,
  _nameWords,
  _translit,
  isArabic,
  _csk,
  _normRef,
  _looksLikeBookingRef,
  scoreReservations,
  _allWords,
  _isShortNameBooking,
  _shortNameMatches,
  nameMatch,
  partialNameMatch,
  _stripRoomNum,
  _relatedBookings,
  _elevatorUpdatedMs,
  _buildElevatorMerged,
};
