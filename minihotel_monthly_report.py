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
import os
from typing import Optional
import smtplib
import ssl
import sys
import traceback
from datetime import datetime, timedelta, timezone
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
LOGIN_HOTEL_SELECTOR    = '#txt_hotel_code'
LOGIN_USERNAME_SELECTOR = '#txt_username'
LOGIN_PASSWORD_SELECTOR = '#txt_password'
LOGIN_SUBMIT_SELECTOR   = '#LoginButton'

# ---- After login: how to get to the report page ----------------
# Option A: URL is known
REPORT_PAGE_URL = ""                                  # leave empty if you have to click through
NAVIGATE_TO_RESERVATIONS_SELECTOR = '#ctrl_label5_lbl_7'
NAVIGATE_TO_QUERY_SELECTOR = '#ctrl_label4_lbl_216'

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
DOWNLOAD_DIR = os.path.expanduser("~/minihotel_exports")

# ---- Email (Gmail SMTP) ----------------------------------------
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465                                       # SSL port
SMTP_USER = "info@maxelaapartments.com"               # the sender's Gmail address
SMTP_PASS = "jiup dyrf famd uapa"                     # Gmail APP PASSWORD (not your normal password!)
SMTP_FROM = "info@maxelaapartments.com"
SMTP_TO   = "info@maxelaapartments.com"               # where the report should land

# ---- Browser behavior ------------------------------------------
HEADLESS = True
DEFAULT_TIMEOUT_MS = 15_000                           # 15s for any single action


# ================================================================
# Main automation
# ================================================================

async def run() -> dict:
    """Returns a dict describing what happened, used for the email body."""
    Path(DOWNLOAD_DIR).mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        # --no-sandbox is required on Android/Termux because Chromium can't
        # use Linux user namespaces in that environment.
        browser = await p.chromium.launch(
            headless=HEADLESS,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",   # avoids /dev/shm size issues on phones
                "--disable-gpu",
            ],
        )
        context = await browser.new_context(accept_downloads=True)
        page = await context.new_page()
        page.set_default_timeout(DEFAULT_TIMEOUT_MS)

        # ---- 1. Login --------------------------------------------------
        await page.goto(PMS_LOGIN_URL, wait_until="domcontentloaded")
        await page.fill(LOGIN_HOTEL_SELECTOR, HOTEL_CODE)
        await page.fill(LOGIN_USERNAME_SELECTOR, USERNAME)
        await page.fill(LOGIN_PASSWORD_SELECTOR, PASSWORD)
        await page.click(LOGIN_SUBMIT_SELECTOR)
        await page.wait_for_load_state("networkidle")

        # ── NAVIGATE TO RESERVATIONS QUERY ──
        await page.click("#ctrl_label5_lbl_7")
        await page.wait_for_timeout(600)
        await page.click("#ctrl_label4_lbl_216")
        await page.wait_for_url("**/ReservationsQuery/**", timeout=10000)
        print("✅ On Reservations Query page")

        # ── HELPER FUNCTIONS ──
        def date_to_ts(dt):
            # Calendar uses UTC midnight timestamps — strip timezone offset
            utc = datetime(dt.year, dt.month, dt.day, tzinfo=timezone.utc)
            local_offset = datetime.now().astimezone().utcoffset()
            return int((utc - local_offset).timestamp() * 1000)

        async def navigate_calendar_to_month(calendar_locator, target_year, target_month):
            for _ in range(24):
                label = await calendar_locator.locator("button.view-switch").inner_text()
                shown = datetime.strptime(label.strip(), "%B %Y")
                if shown.year == target_year and shown.month == target_month:
                    return
                if (shown.year, shown.month) < (target_year, target_month):
                    await calendar_locator.locator("button.next-btn").click()
                else:
                    await calendar_locator.locator("button.prev-btn").click()
                await page.wait_for_timeout(300)

        async def pick_date(button_index, target_dt):
            ts = date_to_ts(target_dt)
            buttons = page.locator("button.main-filter")
            await buttons.nth(button_index).click()
            await page.wait_for_timeout(500)
            calendar = page.locator("div.datepicker-picker").first
            await calendar.wait_for(state="visible", timeout=5000)
            await navigate_calendar_to_month(calendar, target_dt.year, target_dt.month)
            cell = calendar.locator(f'span.datepicker-cell[data-date="{ts}"]')
            await cell.wait_for(state="visible", timeout=3000)
            await cell.click()
            await page.wait_for_timeout(400)

        # ── DATES ──
        from datetime import datetime, timedelta
        date_from = datetime.now()
        date_to   = date_from + timedelta(days=14)

        # ── SET FROM / TO ──
        await pick_date(1, date_from)
        print(f"✅ FROM set")
        await pick_date(2, date_to)
        print(f"✅ TO set")

        # ── SEARCH ──
        await page.click("button.search-button")
        await page.wait_for_function(
            "() => !document.querySelector('button.search-button').disabled",
            timeout=30000
        )
        await page.wait_for_timeout(1000)
        print("✅ Results loaded")

        # ── EXPORT ──
        export_btn = page.locator("button", has_text="Export to excel")
        async with page.expect_download(timeout=30000) as dl_info:
            await export_btn.click()
        download = await dl_info.value
        filename = f"minihotel_{date_from.strftime('%Y%m%d')}_{date_to.strftime('%Y%m%d')}.xlsx"
        filepath = os.path.join(DOWNLOAD_DIR, filename)
        await download.save_as(filepath)
        print(f"✅ Downloaded: {filepath}")

        await context.close()
        await browser.close()

        return {
            "ok": True,
            "start": date_from.strftime("%Y-%m-%d"),
            "end": date_to.strftime("%Y-%m-%d"),
            "file": filepath,
            "size_bytes": os.path.getsize(filepath),
        }


# ================================================================
# Email
# ================================================================

def send_email(result: dict, error: Optional[str] = None) -> None:
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
