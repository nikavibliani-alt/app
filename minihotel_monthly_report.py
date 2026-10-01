import os
import sys
import smtplib
import traceback
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email.mime.text import MIMEText
from email import encoders

import requests
from bs4 import BeautifulSoup

HOTEL_CODE = "freedo45"
USERNAME = "komp"
PASSWORD = "Katleti1"
SMTP_USER = "info@maxelaapartments.com"
SMTP_PASS = os.environ.get("SMTP_PASS", "")
EMAIL_TO = "info@maxelaapartments.com"

def run():
    date_from = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
    date_to = (datetime.now() + timedelta(days=14)).strftime("%Y-%m-%d")
    print(f"Exporting {date_from} to {date_to}")

    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0"})

    r = session.get("https://login.minihotel.cloud/login.aspx", timeout=30)
    soup = BeautifulSoup(r.text, "html.parser")
    payload = {
        "__EVENTTARGET": "LoginButton",
        "__EVENTARGUMENT": "",
        "__VIEWSTATE": soup.find("input", {"id": "__VIEWSTATE"})["value"],
        "__VIEWSTATEGENERATOR": soup.find("input", {"id": "__VIEWSTATEGENERATOR"})["value"],
        "__EVENTVALIDATION": soup.find("input", {"id": "__EVENTVALIDATION"})["value"],
        "txt_hotel_code": HOTEL_CODE,
        "txt_username": USERNAME,
        "txt_password": PASSWORD,
        "hdd_language": "en",
        "txt_agent_username": "",
        "txt_agent_password": "",
    }
    r2 = session.post("https://login.minihotel.cloud/login.aspx", data=payload, timeout=30)
    if "login.aspx" in r2.url.lower():
        raise RuntimeError(f"Login failed - still on: {r2.url}")
    print(f"Logged in: {r2.url}")

    export_payload = {
        "searchBy": "Arrivals",
        "from": date_from,
        "to": date_to,
        "reservationId": "",
        "status": [],
        "additionalFilters": [
            {"id": "firstName", "value": ""},
            {"id": "lastName", "value": ""},
            {"id": "portalId", "value": ""},
        ],
        "additionalFields": {"user": True, "customFields": []}
    }
    r3 = session.post(
        "https://ssl20.minihotelpms.com/api/ReservationsQuery/Excel",
        json=export_payload,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        timeout=60
    )
    r3.raise_for_status()
    print(f"Export status: {r3.status_code}, size: {len(r3.content)}")

    filename = f"minihotel_{date_from}_{date_to}.xlsx"

    msg = MIMEMultipart()
    msg["From"] = SMTP_USER
    msg["To"] = EMAIL_TO
    msg["Subject"] = f"[MiniHotel Sync] Report {date_from} to {date_to}"
    msg.attach(MIMEText(f"MiniHotel export. Date range: {date_from} to {date_to}", "plain"))

    part = MIMEBase("application", "octet-stream")
    part.set_payload(r3.content)
    encoders.encode_base64(part)
    part.add_header("Content-Disposition", f'attachment; filename="{filename}"')
    msg.attach(part)

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(SMTP_USER, SMTP_PASS)
        server.send_message(msg)
    print("Email sent!")

if __name__ == "__main__":
    try:
        run()
        sys.exit(0)
    except Exception as exc:
        print(f"FAILED:\n{traceback.format_exc()}", file=sys.stderr)
        sys.exit(1)