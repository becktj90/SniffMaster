---
name: Brevo transactional SMS has no per-message delivery-status endpoint
description: Unlike Twilio's GET /Messages/{sid}, Brevo's SMS API has no way to poll a single send's carrier delivery status by id.
---

Confirmed by reading Brevo's official server SDK source directly (`sib-api-v3-sdk` 7.6.0, `TransactionalSmsApi`): the only endpoints are `send_transac_sms` (the send itself), `get_sms_events` (filters by phoneNumber/date-range/event/tags — not by a specific message id or reference), and aggregate/report endpoints. There is no `get_transac_sms(id)`-style single-message lookup.

**Why this matters:** the project's own hard-learned lesson (see the Twilio and AT&T-gateway memory notes) is "API accepted ≠ delivered." With Twilio, that gap was closeable — poll `GET /Messages/{sid}.json` a few seconds after sending and read the real `status`/`error_code`. With Brevo, there is no equivalent synchronous check available to a simple script. The only ways to confirm real delivery are (a) Brevo's `webUrl` field on the send request, which POSTs a delivery-report webhook to a URL you host (requires a public HTTP endpoint, not just a script), or (b) manually checking Transactional → SMS → Logs in the Brevo dashboard.

**How to apply:** don't build or promise a Twilio-style delivery-status poll for Brevo — it would be calling an endpoint that doesn't exist for this purpose, or silently no-op. Log the send `reference`/`smsCount`/`remainingCredits` as "accepted," say so explicitly (not "delivered"), and point the user at the dashboard logs if a text doesn't arrive. If reliable programmatic delivery confirmation is later required, implement the `webUrl` webhook receiver rather than trying to fake a poll.

Also verified from the same SDK source: the request body is `{sender, recipient, content, type, tag?, webUrl?, unicodeEnabled?, organisationPrefix?}` (POST `https://api.brevo.com/v3/transactionalSMS/sms`, auth via the `api-key` header — not Bearer/Basic). `recipient` is documented as "mobile number with the country code"; every real-world example omits the leading `+` (digits only), so convert from E.164 at the call site rather than assume `+` is accepted.
