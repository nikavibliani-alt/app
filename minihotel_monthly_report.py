"""
MiniHotel Monthly Report Automation
====================================

Logs into MiniHotel using requests + BeautifulSoup, navigates to the
Reservations Query page, submits the export form, downloads the Excel
file, and emails it via Gmail SMTP.

No browser required — runs headless anywhere Python + pip work.
SMTP_PASS must be set as an environment variable (Gmail App Password).
"""

import os
import smtplib
import ssl
import sys
import traceback
from datetime import datetime, timedelta
from email.message import EmailMessage
from typing import Optional

import requests
from bs4 import BeautifulSoup


# ================================================================
# CONFIG
# ================================================================

PMS_BASE_URL  = "https://login.minihotel.cloud"
PMS_LOGIN_URL = f"{PMS_BASE_URL}/login.aspx"
HOTEL_CODE    = "freedo45"
USERNAME      = "komp"
PASSWORD      = "Katleti1"

# ---- Login form field names (from page source) -----------------
LOGIN_HOTEL_FIELD    = "txt_hotel_code"
LOGIN_USERNAME_FIELD = "txt_username"
LOGIN_PASSWORD_FIELD = "txt_password"
LOGIN_SUBMIT_FIELD   = "LoginButton"

# ---- Reservations Query page -----------------------------------
# Adjust path if MiniHotel redirects elsewhere after login
QUERY_PATH = "/ReservationsQuery/ReservationsQuery.aspx"

# ---- Export form field names (inspect Network tab to confirm) --
# These are the POST body fields sent when clicking "Export to excel"
EXPORT_DATE_FROM_FIELD = "dateFrom"
EXPORT_DATE_TO_FIELD   = "dateTo"
EXPORT_SUBMIT_FIELD    = "btnExportExcel"
EXPORT_SUBMIT_VALUE    = "Export to excel"

DATE_FORMAT  = "%d.%m.%Y"
DAYS_FORWARD = 14

# ---- File download ---------------------------------------------
DOWNLOAD_DIR = os.path.expanduser("~/minihotel_exports")

# ---- Email (Gmail SMTP) ----------------------------------------
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_USER = os.environ.get("SMTP_USER", "info@maxelaapartments.com")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
EMAIL_TO  = os.environ.get("EMAIL_TO", "info@maxelaapartments.com")
SMTP_FROM = "info@maxelaapartments.com"
SMTP_TO   = EMAIL_TO


# ================================================================
# Helpers
# ================================================================

def hidden_fields(soup: BeautifulSoup) -> dict:
    """Return all hidden <input> fields from the page (ASP.NET ViewState etc.)."""
    return {
        inp["name"]: inp.get("value", "")
        for inp in soup.find_all("input", type="hidden")
        if inp.get("name")
    }


# ================================================================
# Main automation
# ================================================================

def run() -> dict:
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)

    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0"})

    # ---- 1. Load login page, grab hidden ASP.NET fields ------------
    resp = session.get(PMS_LOGIN_URL, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    payload = hidden_fields(soup)
    payload.update({
        LOGIN_HOTEL_FIELD:    HOTEL_CODE,
        LOGIN_USERNAME_FIELD: USERNAME,
        LOGIN_PASSWORD_FIELD: PASSWORD,
        LOGIN_SUBMIT_FIELD:   "Login",
    })

    # ---- 2. POST login ---------------------------------------------
    resp = session.post(PMS_LOGIN_URL, data=payload, timeout=30)
    resp.raise_for_status()

    if "login.aspx" in resp.url.lower():
        raise RuntimeError(
            f"Login failed — still on login page. "
            f"Check credentials or field names. URL: {resp.url}"
        )

    print("✅ Logged in")
    logged_in_base = resp.url.rsplit("/", 1)[0]

    # ---- 3. Navigate to Reservations Query -------------------------
    query_url = logged_in_base + QUERY_PATH
    resp = session.get(query_url, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    print(f"✅ On Reservations Query page ({resp.url})")

    # ---- 4. Build export payload -----------------------------------
    date_from = datetime.now()
    date_to   = date_from + timedelta(days=DAYS_FORWARD)
    from_str  = date_from.strftime(DATE_FORMAT)
    to_str    = date_to.strftime(DATE_FORMAT)

    payload = hidden_fields(soup)
    payload.update({
        EXPORT_DATE_FROM_FIELD: from_str,
        EXPORT_DATE_TO_FIELD:   to_str,
        EXPORT_SUBMIT_FIELD:    EXPORT_SUBMIT_VALUE,
    })

    print(f"⏳ Exporting {from_str} → {to_str} ...")

    # ---- 5. POST export, stream download ---------------------------
    resp = session.post(resp.url, data=payload, timeout=60, stream=True)
    resp.raise_for_status()

    content_type = resp.headers.get("Content-Type", "")
    if "html" in content_type.lower():
        snippet = BeautifulSoup(resp.text[:2000], "html.parser").get_text(" ", strip=True)
        raise RuntimeError(
            f"Export returned HTML instead of a file. "
            f"Form field names may need updating.\n"
            f"Page snippet: {snippet[:400]}"
        )

    filename = (
        f"minihotel_{date_from.strftime('%Y%m%d')}"
        f"_{date_to.strftime('%Y%m%d')}.xlsx"
    )
    filepath = os.path.join(DOWNLOAD_DIR, filename)

    with open(filepath, "wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            if chunk:
                f.write(chunk)

    size = os.path.getsize(filepath)
    print(f"✅ Downloaded: {filepath} ({size:,} bytes)")

    return {
        "ok":         True,
        "start":      from_str,
        "end":        to_str,
        "file":       filepath,
        "size_bytes": size,
    }


# ================================================================
# Email
# ================================================================

def send_email(result: dict, error: Optional[str] = None) -> None:
    msg = EmailMessage()

    if error:
        msg["Subject"] = "[MiniHotel Sync] ❌ FAILED"
        msg.set_content(
            f"MiniHotel report automation failed.\n\nError:\n{error}\n"
        )
    else:
        msg["Subject"] = (
            f"[MiniHotel Sync] ✅ Report "
            f"{result['start']} → {result['end']}"
        )
        msg.set_content(
            f"MiniHotel report exported successfully.\n\n"
            f"Date range: {result['start']} → {result['end']}\n"
            f"File size:  {result['size_bytes']:,} bytes\n"
            f"Saved to:   {result['file']}\n"
        )
        file_path = result["file"]
        with open(file_path, "rb") as f:
            data = f.read()
        msg.add_attachment(
            data,
            maintype="application",
            subtype="octet-stream",
            filename=os.path.basename(file_path),
        )

    msg["From"] = SMTP_FROM
    msg["To"]   = SMTP_TO

    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ctx) as server:
        server.login(SMTP_USER, SMTP_PASS)
        server.send_message(msg)


# ================================================================
# Entry point
# ================================================================

if __name__ == "__main__":
    try:
        result = run()
        send_email(result)
        print(f"OK: {result}")
        sys.exit(0)
    except Exception as exc:
        tb = traceback.format_exc()
        print(f"FAILED:\n{tb}", file=sys.stderr)
        try:
            send_email(result={}, error=f"{exc}\n\n{tb}")
        except Exception as mail_exc:
            print(f"Also failed to send error email: {mail_exc}", file=sys.stderr)
        sys.exit(1)
