#!/usr/bin/env python3
"""
Daily Automated Spare Parts Sync from Email (IMAP) -> spare_parts_data.json
Uses Python 3 standard library only (zero external dependencies).

Environment variables:
  EMAIL_USER          - Email address (e.g. amr.hamdy1111@gmail.com)
  EMAIL_APP_PASSWORD  - Gmail App Password (16-char) or IMAP password
  IMAP_HOST           - Optional, defaults to imap.gmail.com
  EMAIL_SUBJECTS      - Optional comma-separated subjects to match
                        (defaults to: super pates,spare parts,spars parts)
"""

import email
import imaplib
import os
import sys
import tempfile
from email.header import decode_header
from email.utils import parsedate_to_datetime
from datetime import timezone

# Import our converter from scripts/import_spares_csv.py
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
import import_spares_csv  # noqa: E402


def decode_mime_str(raw_val: str) -> str:
    if not raw_val:
        return ""
    parts = decode_header(raw_val)
    out = []
    for content, charset in parts:
        if isinstance(content, bytes):
            out.append(content.decode(charset or "utf-8", errors="replace"))
        else:
            out.append(str(content))
    return "".join(out)


def fetch_latest_spares_csv():
    user = os.environ.get("EMAIL_USER", "").strip()
    password = os.environ.get("EMAIL_APP_PASSWORD", "").strip()
    imap_host = os.environ.get("IMAP_HOST", "imap.gmail.com").strip() or "imap.gmail.com"
    subjects_raw = os.environ.get("EMAIL_SUBJECTS", "super pates,spare parts,spars parts")
    subject_terms = [s.strip() for s in subjects_raw.split(",") if s.strip()]

    if not user or not password:
        print("ERROR: EMAIL_USER and EMAIL_APP_PASSWORD secrets are required.", file=sys.stderr)
        sys.exit(1)

    print(f"Connecting to {imap_host} as {user}...")
    mail = imaplib.IMAP4_SSL(imap_host, 993)
    try:
        mail.login(user, password)
        mail.select("INBOX", readonly=True)

        candidate_ids = set()
        for term in subject_terms:
            status, data = mail.search(None, "SUBJECT", f'"{term}"')
            if status == "OK" and data and data[0]:
                for msg_id in data[0].split():
                    candidate_ids.add(int(msg_id))

        if not candidate_ids:
            print(f"No emails matched subjects: {subject_terms}")
            return None, None, None

        # Check newest matching emails first (up to latest 15)
        sorted_ids = sorted(candidate_ids, reverse=True)[:15]
        for msg_id in sorted_ids:
            status, msg_data = mail.fetch(str(msg_id), "(RFC822)")
            if status != "OK" or not msg_data or not msg_data[0]:
                continue
            raw_bytes = msg_data[0][1]
            msg = email.message_from_bytes(raw_bytes)
            subj = decode_mime_str(msg.get("Subject", ""))
            date_hdr = msg.get("Date", "")
            try:
                dt = parsedate_to_datetime(date_hdr)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                iso_date = dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            except Exception:
                iso_date = ""

            for part in msg.walk():
                if part.get_content_maintype() == "multipart":
                    continue
                filename = decode_mime_str(part.get_filename() or "")
                if not filename:
                    continue
                if filename.lower().endswith(".csv"):
                    payload = part.get_payload(decode=True)
                    if payload:
                        print(f"Found CSV attachment '{filename}' in email '{subj}' ({iso_date})")
                        return payload, filename, iso_date

        print("Matched emails found, but none contained a .csv attachment.")
        return None, None, None
    finally:
        try:
            mail.logout()
        except Exception:
            pass


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "spare_parts_data.json"
    csv_bytes, filename, iso_date = fetch_latest_spares_csv()
    if not csv_bytes:
        print("No update performed.")
        return

    with tempfile.NamedTemporaryFile(mode="wb", suffix=".csv", delete=False) as tf:
        tf.write(csv_bytes)
        tmp_csv = tf.name

    try:
        import_spares_csv.convert_csv(tmp_csv, out_path, source_date=iso_date)
    finally:
        if os.path.exists(tmp_csv):
            os.remove(tmp_csv)


if __name__ == "__main__":
    main()
