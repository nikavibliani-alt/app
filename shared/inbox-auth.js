/**
 * Sign-in for the Booking.com guest inbox. Same screen and flow as owner-auth.js (which stays
 * owner-only for the pricing pages), but any verified Google account on INBOX_USERS may enter.
 *
 * The page imports firebase-auth at the same version as its firebase-app and passes the pieces in
 * (versions must match), then calls requireInboxUser(). The page content is only started (onReady)
 * for a verified address on the list. Firestore rules and the Cloud Functions enforce the same
 * thing on the server (pipeline-functions/lib/inboxAccess.js is the one list for the functions, and
 * a unit test checks this list against it); this screen is only the friendly front door.
 */
export const INBOX_USERS = [
  { email: "nikavibliani@gmail.com", name: "Nika" },
  { email: "nutsamargiani@gmail.com", name: "Nutsa" },
];
export const inboxUserFor = email => INBOX_USERS.find(u => u.email === String(email || "").toLowerCase()) || null;

const CSS = `
#ownerAuth{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:1000;
  background:#FAFAF9;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;letter-spacing:-.01em}
#ownerAuth .oa-box{background:#fff;border:1px solid #E8E4E0;border-radius:12px;
  padding:2rem 1.6rem;text-align:center;max-width:340px;width:calc(100% - 32px)}
#ownerAuth .oa-title{font-weight:700;font-size:1.05rem;color:#2C2C2A;margin-bottom:.35rem}
#ownerAuth .oa-sub{font-size:.88rem;color:#6B6B68;margin-bottom:1.1rem;line-height:1.4}
#ownerAuth button{font:inherit;font-size:.95rem;font-weight:600;min-height:48px;padding:0 1.1rem;border-radius:10px;cursor:pointer;
  border:1.5px solid #2C2C2A;background:#2C2C2A;color:#ffffff;width:100%;touch-action:manipulation}
#ownerAuth button:disabled{opacity:.55;cursor:default}
#ownerAuth .oa-msg{min-height:1.2em;margin-top:.8rem;font-size:.85rem;color:#8b2020;line-height:1.35}
#ownerAuth .oa-back{display:inline-flex;align-items:center;justify-content:center;min-height:44px;margin-top:.6rem;font-size:.9rem;font-weight:600;color:#2C2C2A}
`;

function build() {
  if (document.getElementById("ownerAuth")) return document.getElementById("ownerAuth");
  const st = document.createElement("style");
  st.textContent = CSS;
  document.head.appendChild(st);
  const el = document.createElement("div");
  el.id = "ownerAuth";
  el.innerHTML = `<div class="oa-box">
    <div class="oa-title">Inbox sign-in</div>
    <div class="oa-sub">This page is only for the people who run the inbox. Sign in with your Google account.</div>
    <button type="button" id="oaBtn">Sign in with Google</button>
    <div class="oa-msg" id="oaMsg" role="status"></div>
    <a class="oa-back" href="/checkin-admin">Back to admin</a></div>`;
  document.body.appendChild(el);
  return el;
}

const FRIENDLY = {
  "auth/operation-not-allowed": "Google sign-in is not turned on yet. In the Firebase console open Authentication, Sign-in method, and turn Google on.",
  "auth/unauthorized-domain": "This web address is not on the authorized domains list. Add it in the Firebase console under Authentication, Settings.",
  "auth/popup-closed-by-user": "The sign-in window was closed. Try again.",
  "auth/network-request-failed": "No connection. Check the internet and try again.",
};

export function requireInboxUser(sdk, { onReady } = {}) {
  const { auth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut } = sdk;
  const overlay = build();
  const msg = overlay.querySelector("#oaMsg");
  const btn = overlay.querySelector("#oaBtn");
  let started = false;
  const say = t => { msg.textContent = t || ""; };
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  btn.onclick = async () => {
    say(""); btn.disabled = true;
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      const c = e && e.code;
      if (c === "auth/popup-blocked" || c === "auth/operation-not-supported-in-this-environment") {
        try { await signInWithRedirect(auth, provider); return; } catch (e2) { say(FRIENDLY[e2.code] || "Sign-in failed (" + (e2.code || e2.message) + ")."); }
      } else if (c !== "auth/cancelled-popup-request") {
        say(FRIENDLY[c] || "Sign-in failed (" + (c || (e && e.message)) + ").");
      }
    }
    btn.disabled = false;
  };

  if (getRedirectResult) getRedirectResult(auth).catch(e => say(FRIENDLY[e && e.code] || "Sign-in failed (" + (e && e.code) + ")."));

  onAuthStateChanged(auth, user => {
    if (user && user.emailVerified && inboxUserFor(user.email)) {
      overlay.style.display = "none";
      if (!started) { started = true; onReady(user); }
      return;
    }
    if (user) {
      say("That Google account (" + (user.email || "unknown") + ") is not allowed here. Use the Google account you were given for the inbox.");
      signOut(auth).catch(() => {});
    }
    overlay.style.display = "flex";
    btn.disabled = false;
  });
}
