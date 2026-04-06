#!/usr/bin/env python3
"""
Mock a priority sulfur/VSC event POST so the hosted dashboard can be tested
without needing a live sensor event.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Send a mock SniffMaster sulfur/VSC event")
    parser.add_argument("--url", default="https://sniffmaster-web.vercel.app/api/sniff",
                        help="sniff endpoint URL")
    parser.add_argument("--key", required=True, help="shared SNIFFMASTER_API_KEY")
    parser.add_argument("--iaq", type=int, default=92, help="IAQ value for the mock event")
    parser.add_argument("--vsc-conf", type=float, default=78.5,
                        help="sulfur/VSC proxy confidence percentage")
    parser.add_argument("--label", default="Sulfur",
                        help="event label shown in the live dashboard")
    parser.add_argument("--air-score", type=int, default=34, help="optional room score")
    parser.add_argument("--voc", type=float, default=1.82, help="optional VOC value")
    parser.add_argument("--dvoc", type=float, default=0.94, help="optional dVOC rise")
    parser.add_argument("--primary", default="Sulfur", help="optional primary odor label")
    parser.add_argument("--primary-conf", type=int, default=72,
                        help="optional primary odor confidence")
    parser.add_argument("--fart-count", type=int, default=1, help="optional fart count")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    payload = {
        "key": args.key,
        "iaq": args.iaq,
        "vsc_conf": args.vsc_conf,
        "label": args.label,
        "airScore": args.air_score,
        "voc": args.voc,
        "dVoc": args.dvoc,
        "primary": args.primary,
        "primaryConf": args.primary_conf,
        "fartCount": args.fart_count,
    }

    request = urllib.request.Request(
        args.url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            body = response.read().decode("utf-8", "replace")
            print(f"HTTP {response.status}")
            print(body)
            return 0
    except urllib.error.HTTPError as err:
        print(f"HTTP {err.code}", file=sys.stderr)
        print(err.read().decode("utf-8", "replace"), file=sys.stderr)
        return 1
    except urllib.error.URLError as err:
        print(f"Request failed: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
