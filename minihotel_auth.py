"""
MiniHotel Authentication Helper
=================================
Handles ASP.NET WebForms login to get a fresh session cookie.
Used by pricing_engine.py and read_pricing.py.
"""

import re
import requests
from urllib.parse import urljoin

LOGIN_URL = "https://login.minihotel.cloud/login.aspx"
DASHBOARD_URL = "https://ssl20.minihotelpms.com/Home/dashboard.aspx"

import os
HOTEL_CODE = os.environ.get("MINIHOTEL_HOTEL", "freedo45")
USERNAME   = os.environ.get("MINIHOTEL_USER", "nika")
PASSWORD   = os.environ.get("MINIHOTEL_PASS", "Katleti")


def get_session_cookie() -> str:
    """
    Logs into MiniHotel and returns the full cookie string
    ready to use as a Cookie: header value.
    """
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/124.0 Safari/537.36",
    })

    # Step 1: GET login page to extract ASP.NET hidden fields
    resp = session.get(LOGIN_URL, timeout=30)
    resp.raise_for_status()
    html = resp.text

    def extract(field):
        match = re.search(
            rf'id="{re.escape(field)}"\s+value="([^"]*)"', html
        ) or re.search(
            rf'name="{re.escape(field)}"\s+[^>]*value="([^"]*)"', html
        )
        return match.group(1) if match else ""

    viewstate          = extract("__VIEWSTATE")
    viewstate_gen      = extract("__VIEWSTATEGENERATOR")
    event_validation   = extract("__EVENTVALIDATION")

    if not viewstate:
        raise RuntimeError("Could not extract __VIEWSTATE from login page. "
                           "MiniHotel login page structure may have changed.")

    # Step 2: POST credentials
    payload = {
        "LoginButton":          "Login",
        "__EVENTARGUMENT":      "",
        "__VIEWSTATE":          viewstate,
        "__VIEWSTATEGENERATOR": viewstate_gen,
        "__EVENTVALIDATION":    event_validation,
        "txt_hotel_code":       HOTEL_CODE,
        "txt_username":         USERNAME,
        "txt_password":         PASSWORD,
        "hdd_language":         "en",
        "txt_agent_username":   "",
        "txt_agent_password":   "",
    }

    resp = session.post(
        LOGIN_URL,
        data=payload,
        allow_redirects=True,
        timeout=30,
    )

    # Check we landed on the dashboard (not back on login page)
    if "login" in resp.url.lower() or "dashboard" not in resp.url.lower():
        raise RuntimeError(
            f"Login failed — ended up at {resp.url}. "
            "Check credentials or hotel code."
        )

    # Build cookie string — only include cookies scoped to the API host
    # (session also holds cookies from login.minihotel.cloud which must be excluded)
    cookie_str = "; ".join(
        f"{c.name}={c.value}"
        for c in session.cookies
        if "minihotelpms.com" in (c.domain or "")
    )
    # Fallback: if domain filtering yielded nothing, take all cookies
    if not cookie_str:
        cookie_str = "; ".join(f"{c.name}={c.value}" for c in session.cookies)

    if "ASP.NET_SessionId" not in cookie_str:
        raise RuntimeError(
            "Login appeared to succeed but no ASP.NET_SessionId in cookies. "
            f"Cookie string: {cookie_str[:200]}"
        )

    # Append hotel-specific cookies that the API requires but are only set
    # by browser-side JS on dashboard load (static for this account).
    if "hotelName" not in cookie_str:
        cookie_str += (
            "; hotelName=Freedom+square+studios"
            "; gdsCode=freedo45"
            "; userName=nika"
            "; TawkConnectionTime=0"
        )

    return cookie_str


if __name__ == "__main__":
    print("Testing MiniHotel login...")
    cookie = get_session_cookie()
    print(f"OK — got cookie: {cookie[:80]}...")
    session_id = [p for p in cookie.split("; ") if "ASP.NET_SessionId" in p]
    print(f"Session ID: {session_id[0] if session_id else 'NOT FOUND'}")
