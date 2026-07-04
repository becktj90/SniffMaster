---
name: Replit secret value silently truncated
description: A specific Replit Secrets entry can get silently truncated on save, even after being re-entered correctly multiple times.
---

Observed once: a secret (a 32-character Twilio auth token) stored via Replit Secrets kept getting silently truncated to 25 characters no matter how many times it was re-entered by the user, causing downstream API auth failures (401s) that looked like a wrong/expired credential rather than a storage bug.

**Why:** Confirmed by inspecting the live env directly (`/run/replit/env/latest.json`, parsed as JSON to avoid shell-quoting/whitespace display artifacts) — the stored value was consistently 25 chars when the real token is 32 chars, across multiple re-entry attempts under the same key name.

**How to apply:** If a secret value behaves as if truncated/corrupted (e.g. consistent-length auth failures) despite repeated correct re-entry, don't loop indefinitely re-requesting the same key — verify the actual stored value via `/run/replit/env/latest.json` (parse as JSON, not grep on the raw file, which truncates at spaces) to confirm truncation is really happening. As a workaround, store the same value under a different secret key name (e.g. append `_V2`) and prefer that key in code; this has been observed to bypass the truncation. Note in code/docs why the fallback key exists so it isn't "cleaned up" later by someone unaware of the bug.
