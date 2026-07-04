---
name: Email-to-SMS gateway reliability
description: AT&T's carrier email-to-SMS gateway can accept mail via SMTP but silently never deliver the text — verified live, not theoretical.
---

Successful SMTP delivery to a carrier's email-to-SMS gateway address (e.g. `<number>@txt.att.net`, `<number>@mms.att.net`) does NOT guarantee the SMS reaches the phone. AT&T in particular is known to filter/drop this traffic silently — no bounce, no SMTP error, the sending mail server just reports success.

**Why:** Confirmed via live end-to-end test — correct 10-digit AT&T gateway address, correct carrier, valid Gmail App Password/SMTP creds, script logged "SMS sent successfully" — and no text arrived on the target phone across repeated attempts on both `txt.att.net` and `mms.att.net`. This matches a widely-reported real-world pattern of carriers clamping down on email-to-SMS as a spam vector.

**How to apply:** When building or verifying any email-to-SMS forwarding feature (ntfy/alerting/notification scripts, etc.), do not treat "SMTP accepted" as proof of delivery — always confirm with an actual phone check. If delivery must be reliable, recommend switching to a dedicated transactional SMS API (e.g. Twilio) instead of continuing to debug the email gateway route, since the failure is carrier-side and outside the sender's control. Also watch for the common formatting bug of a leading country-code `1` in the gateway address (e.g. `15551234567@txt.att.net`) — invalid for AT&T's expected 10-digit format, though fixing it alone does not solve carrier-side filtering.
