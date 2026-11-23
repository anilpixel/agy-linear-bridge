#!/usr/bin/env python3
"""Best-effort cancellation helper that attaches to an active `agy --remote-agent` conversation and sends Esc."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

from provision_remote_projects import PtySession
from watch_remote_agent import extract_snapshot


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Send Esc to cancel an active `agy --remote-agent` conversation"
    )
    parser.add_argument("--agy-bin", default="agy")
    parser.add_argument("--conversation", required=True)
    parser.add_argument("--project", default="")
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--ready-timeout", type=float, default=25.0)
    parser.add_argument("--cancel-timeout", type=float, default=10.0)
    args = parser.parse_args()

    extra_args = ["--conversation", args.conversation]
    if args.project:
        extra_args.extend(["--project", args.project])

    try:
        with PtySession(
            agy_bin=args.agy_bin,
            cwd=args.cwd,
            extra_args=extra_args,
            rows=60,
            cols=140,
        ) as sess:
            sess.wait_log(
                rf"Streaming conversation {re.escape(args.conversation)}",
                timeout=args.ready_timeout,
            )
            sess.pump(2.0)

            snap = extract_snapshot(sess.term.lines())
            was_running = bool(snap["isRunning"])
            still_running = was_running
            cancelled = False

            if was_running:
                sess.send_bytes(b"\x1b")
                started_cancel = time.monotonic()
                deadline = started_cancel + args.cancel_timeout
                second_sent = False

                while time.monotonic() < deadline:
                    sess.pump(0.5)
                    snap = extract_snapshot(sess.term.lines())
                    if not snap["isRunning"]:
                        still_running = False
                        cancelled = True
                        break
                    if not second_sent and time.monotonic() - started_cancel >= 2.5:
                        sess.send_bytes(b"\x1b")
                        second_sent = True

            print(
                json.dumps(
                    {
                        "ok": True,
                        "conversationId": args.conversation,
                        "wasRunning": was_running,
                        "cancelled": cancelled,
                        "stillRunning": still_running,
                    },
                    ensure_ascii=False,
                )
            )
            return 0
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "conversationId": args.conversation,
                    "error": str(exc),
                },
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
