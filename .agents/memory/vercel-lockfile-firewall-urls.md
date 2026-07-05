---
name: Vercel breaks on Replit lockfile URLs
description: package-lock.json resolved URLs get rewritten to package-firewall.replit.local by any npm install inside Replit, which breaks Vercel's npm ci.
---

**Rule:** Before pushing to GitHub for a Vercel deploy, check `web/package-lock.json` for `package-firewall.replit.local` URLs and repoint them to `https://registry.npmjs.org` (a plain sed works; integrity hashes stay valid because the firewall proxies the identical npm tarballs).

**Why:** Any `npm install` run inside Replit rewrites `resolved` fields to Replit's internal package firewall, which Vercel's build machines cannot reach — `npm ci` fails and the deploy dies. This regression recurs every time a dependency is added or updated locally (it has broken deploys at least twice: once fixed by remote PR, once caught pre-push on July 5, 2026).

**How to apply:** `grep -c package-firewall web/package-lock.json` must be 0 before any push. If not: `sed -i 's|http://package-firewall.replit.local/npm|https://registry.npmjs.org|g' web/package-lock.json`, then validate with `node -e "JSON.parse(...)"`.
