"""
MiniHotel Monthly Report Automation
====================================

Logs into MiniHotel, opens the date-range modal, enters target dates,
triggers the report export, downloads the file, and emails it as an
attachment via Gmail SMTP.

Designed to run headless on Android Termux, triggered by MacroDroid.

Setup steps are in setup.sh — read those first.

Configure all CAPS variables below before running.
"""

import asyncio
import smtplib
import ssl
import sys
import traceback
from datetime import datetime, timedelta
from email.message import EmailMessage
from pathlib import Path

from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout


# ================================================================
# CONFIG — edit everything in this block
# ================================================================

# ---- MiniHotel credentials -------------------------------------
PMS_LOGIN_URL = "https://login.minihotel.cloud/login.aspx"
HOTEL_CODE = "freedo45"
USERNAME = "komp"
PASSWORD = "Katleti1"

# ---- Login form selectors (inspect the login page) -------------
LOGIN_USERNAME_SELECTOR = 'input[name="username"]'    # adjust to actual selector
LOGIN_PASSWORD_SELECTOR = 'input[name="password"]'
LOGIN_SUBMIT_SELECTOR   = 'button[type="submit"]'

# ---- After login: how to get to the report page ----------------
# Option A: URL is known
REPORT_PAGE_URL = ""                                  # leave empty if you have to click through

# Option B: click a menu item (used only if REPORT_PAGE_URL is empty)
NAVIGATE_TO_REPORT_SELECTOR = 'a:has-text("Reports")' # menu item to click

# ---- The modal that needs to open ------------------------------
TRIGGER_BUTTON_SELECTOR = 'button:has-text("Reservations Report")'  # button that opens the modal
MODAL_CONTAINER_SELECTOR = '.modal.show, [role="dialog"]'           # the popup container

# ---- Inside the modal ------------------------------------------
START_DATE_INPUT = 'input[name="dateFrom"]'           # date inputs INSIDE the modal
END_DATE_INPUT   = 'input[name="dateTo"]'
SAVE_BUTTON_SELECTOR = 'button:has-text("Export")'    # the export/download button INSIDE the modal

# Date format MiniHotel expects in those inputs.
# Common formats: "%Y-%m-%d" (2026-06-30), "%d/%m/%Y" (30/06/2026), "%d.%m.%Y"
DATE_FORMAT = "%d.%m.%Y"

# How many days the export should cover
DAYS_BACK    = 0       # include today (set to e.g. 7 if you want last week too)
DAYS_FORWARD = 30      # 30 days into the future

# ---- File download ---------------------------------------------
DOWNLOAD_DIR = "/data/data/com.termux/files/home/minihotel-downloads"  # Termux home subdir
# On a regular Linux/Mac: use something like "/tmp/minihotel" or "./downloads"

# ---- Email (Gmail SMTP) ----------------------------------------
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465                                       # SSL port
SMTP_USER = "info@maxelaapartments.com"               # the sender's Gmail address
SMTP_PASS = "abcd efgh ijkl mnop"                     # Gmail APP PASSWORD (not your normal password!)
SMTP_FROM = "info@maxelaapartments.com"
SMTP_TO   = "info@maxelaapartments.com"               # where the report should land

# ---- Browser behavior ------------------------------------------
HEADLESS = True
DEFAULT_TIMEOUT_MS = 15_000                           # 15s for any single action


# ================================================================
# Main automation
# ================================================================

def run() -> dict:
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)

    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0"})

    # Login
    resp = session.get(PMS_LOGIN_URL, timeout=30)
    soup = BeautifulSoup(resp.text, "html.parser")
    payload = hidden_fields(soup)
    payload.update({
        LOGIN_HOTEL_FIELD:    HOTEL_CODE,
        LOGIN_USERNAME_FIELD: USERNAME,
        LOGIN_PASSWORD_FIELD: PASSWORD,
        LOGIN_SUBMIT_FIELD:   "Login",
    })
    resp = session.post(PMS_LOGIN_URL, data=payload, timeout=30)
    if "login.aspx" in resp.url.lower():
        raise RuntimeError("Login failed")
    print("✅ Logged in")

    # Export via API
    date_from = datetime.now() - timedelta(days=30)
    date_to   = datetime.now() + timedelta(days=14)
    from_str  = date_from.strftime("%Y-%m-%d")
    to_str    = date_to.strftime("%Y-%m-%d")

    export_payload = {
        "searchBy": "Arrivals",
        "from": from_str,
        "to": to_str,
        "reservationId": "",
        "status": [],
        "additionalFilters": [
            {"id": "firstName", "value": ""},
            {"id": "lastName", "value": ""},
            {"id": "portalId", "value": ""},
        ],
        "additionalFields": {"user": True, "customFields": []}
    }

    resp = session.post(
        "https://ssl20.minihotelpms.com/api/ReservationsQuery/Excel",
        json=export_payload,
        headers={"Content-Type": "application/json"},
        timeout=60
    )
    resp.raise_for_status()

    filename = f"minihotel_{date_from.strftime('%Y%m%d')}_{date_to.strftime('%Y%m%d')}.xlsx"
    filepath = os.path.join(DOWNLOAD_DIR, filename)
    with open(filepath, "wb") as f:
        f.write(resp.content)

    size = os.path.getsize(filepath)
    print(f"✅ Downloaded: {filepath} ({size:,} bytes)")

    return {
        "ok": True,
        "start": from_str,
        "end": to_str,
        "file": filepath,
        "size_bytes": size,
    }


# ================================================================
# Email
# ================================================================

def send_email(result: dict, error: str | None = None) -> None:
    msg = EmailMessage()

    if error:
        msg["Subject"] = "[MiniHotel Sync] ❌ FAILED"
        body = (
            f"MiniHotel monthly report automation failed.\n\n"
            f"Error:\n{error}\n"
        )
        msg.set_content(body)
    else:
        msg["Subject"] = f"[MiniHotel Sync] ✅ Report {result['start']} → {result['end']}"
        body = (
            f"MiniHotel monthly report exported successfully.\n\n"
            f"Date range: {result['start']} → {result['end']}\n"
            f"File size:  {result['size_bytes']:,} bytes\n"
            f"Saved to:   {result['file']}\n"
        )
        msg.set_content(body)

        # Attach the downloaded file
        file_path = Path(result["file"])
        with file_path.open("rb") as f:
            data = f.read()
        msg.add_attachment(
            data,
            maintype="application",
            subtype="octet-stream",
            filename=file_path.name,
        )

    msg["From"] = SMTP_FROM
    msg["To"] = SMTP_TO

    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ctx) as server:
        server.login(SMTP_USER, SMTP_PASS)
        server.send_message(msg)


# ================================================================
# Entry point
# ================================================================

if __name__ == "__main__":
    try:
        result = asyncio.run(run())
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
