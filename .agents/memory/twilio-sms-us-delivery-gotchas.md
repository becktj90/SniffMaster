---
name: Twilio SMS US delivery gotchas
description: Twilio can return HTTP 200 / a message SID and the text can still never reach a US phone — carrier-side A2P 10DLC registration is required.
---

Twilio accepting a send request (200 response, message SID returned) is not proof of delivery for US numbers. The message can still end up `status: undelivered` with `error_code: 30034` — US carriers require long-code (10-digit) phone numbers to complete **A2P 10DLC registration** (brand + campaign registration for application-to-person messaging) before they will deliver texts. This is a carrier spam-prevention requirement, not a Twilio bug or code issue.

**Why:** Confirmed live — a freshly-provisioned Twilio number sent a test SMS, Twilio's API returned success with a SID, but the carrier marked it undelivered (30034) because the number hadn't completed 10DLC registration. This exists specifically to keep unregistered senders from mass-texting; low-volume/registered brands can be approved same-day, but full vetting can take longer.

**How to apply:**
- Never treat "Twilio API call succeeded" as proof of SMS delivery to a US number. Always poll `GET /Messages/{sid}.json` and check `status` (want `delivered`, not `undelivered`/`failed`) and `error_code` (30034 = unregistered 10DLC), or ask the recipient to confirm receipt.
- If 30034 shows up, the fix is *not* code — the account owner must register a brand/campaign at Twilio Console → Messaging → Regulatory Compliance → A2P 10DLC and attach it to the sending number. This requires real business info the agent should not submit on the user's behalf.
- Also verify the `From` number actually belongs to the Twilio account being used (mismatched From/account raises HTTP 400 error 21660) and is in strict E.164 format (`+1XXXXXXXXXX`) — dashboards sometimes display numbers as `(XXX) XXX-XXXX`, which is not valid input for the API. Normalize phone numbers to E.164 in code rather than relying on user-provided formatting.
