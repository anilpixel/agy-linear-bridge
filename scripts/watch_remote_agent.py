#!/usr/bin/env python3
"""Read-only PTY stream watcher that emits NDJSON status/actions from an active `agy --remote-agent` conversation."""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import sys
import time
from pathlib import Path

_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

from provision_remote_projects import PtySession, read_log_safe

DIVIDER_RE = re.compile(r"^─{20,}$")
SPINNER_LINE_RE = re.compile(r"^[\u2800-\u28ff]\s+(.+)$")
RUNNING_TASK_RE = re.compile(
    r"^[●○]\s+\[\d{2}:\d{2}:\d{2}\]\s+(.+?)\s+running$", re.IGNORECASE
)
ACTION_LINE_RE = re.compile(
    r"^[●○]\s+(Used|Ran|Explored|Edited|Created|Updated|Deleted|Running|Searched|Read|Wrote)\s+(.+)$"
)
THOUGHT_FOR_RE = re.compile(r"^[○▸]\s+Thought for\s+(.+)$")
MORE_ACTIONS_RE = re.compile(r"…\s*(\d+\s+more actions[^…]*?)\s*…")
CTRL_O_SUFFIX_RE = re.compile(r"\s*\(ctrl\+o to expand\)\s*$", re.IGNORECASE)
LOADING_CONV_RE = re.compile(r"^Loading conversation\b", re.IGNORECASE)


def _clean_spinner_text(raw: str) -> str:
    text = re.sub(r"[.…]+$", "", raw.strip()).strip()
    return re.sub(r"\s+", " ", text)


def _find_screen_split(lines: list[str]) -> tuple[list[str], list[str]]:
    """Split rendered screen into content lines above the bottom prompt box and footer lines."""
    if not lines:
        return [], []

    prompt_idx = -1
    for idx in range(len(lines) - 1, -1, -1):
        stripped = lines[idx].strip()
        if stripped == ">" and idx > 0 and DIVIDER_RE.match(lines[idx - 1].strip()):
            prompt_idx = idx - 1
            break

    if prompt_idx >= 0:
        return lines[:prompt_idx], lines[prompt_idx:]

    # Fallback when prompt line isn't bare `>`: look for bottom-most divider near footer hints
    for idx in range(len(lines) - 1, -1, -1):
        if DIVIDER_RE.match(lines[idx].strip()):
            if any(
                "esc to cancel" in l.lower() or "? for shortcuts" in l.lower()
                for l in lines[idx:]
            ):
                # Prefer the top divider of the input box if two adjacent dividers exist
                top_div = idx
                for j in range(idx - 1, max(-1, idx - 4), -1):
                    if DIVIDER_RE.match(lines[j].strip()):
                        top_div = j
                        break
                return lines[:top_div], lines[top_div:]

    return lines, []


def _extract_final_text(content_lines: list[str]) -> str:
    """Collect the final assistant response text below the last thought/tool marker."""
    last_marker = -1
    for idx, raw in enumerate(content_lines):
        s = raw.strip()
        if (
            THOUGHT_FOR_RE.match(s)
            or ACTION_LINE_RE.match(s)
            or MORE_ACTIONS_RE.search(s)
            or s.startswith("▸ Thought")
            or s.startswith("○ Thought")
        ):
            last_marker = idx

    tail = content_lines[last_marker + 1 :] if last_marker >= 0 else []
    cleaned: list[str] = []
    for raw in tail:
        s = raw.strip()
        if not s:
            continue
        if s.startswith("└ Tip:") or DIVIDER_RE.match(s):
            continue
        if SPINNER_LINE_RE.match(s) or RUNNING_TASK_RE.match(s):
            continue
        cleaned.append(raw.strip())

    joined = "\n".join(cleaned).strip()
    if len(joined) > 3000:
        return joined[-3000:]
    return joined


def extract_snapshot(lines: list[str]) -> dict:
    """Parse a rendered TUI frame into structured running state, actions, and final output."""
    normalized = [line.rstrip() for line in lines if line and line.strip()]
    content_lines, footer_lines = _find_screen_split(normalized)

    has_esc_cancel = any("esc to cancel" in l.lower() for l in footer_lines)
    has_shortcuts = any("? for shortcuts" in l.lower() for l in footer_lines)

    raw_spinner_text = ""
    has_loading_spinner = False
    for raw in content_lines:
        s = raw.strip()
        m = SPINNER_LINE_RE.match(s)
        if m:
            candidate = _clean_spinner_text(m.group(1))
            if LOADING_CONV_RE.match(candidate):
                has_loading_spinner = True
            elif candidate:
                raw_spinner_text = candidate

    running_task = ""
    for raw in normalized:
        s = raw.strip()
        m = RUNNING_TASK_RE.match(s)
        if m:
            running_task = re.sub(r"\s+", " ", m.group(1)).strip()

    actions: list[dict[str, str]] = []
    latest_thought = ""
    latest_more_actions = ""
    for raw in content_lines:
        s = raw.strip()
        tm = THOUGHT_FOR_RE.match(s)
        if tm:
            latest_thought = re.sub(r"\s+", " ", tm.group(1)).strip()
            continue

        mm = MORE_ACTIONS_RE.search(s)
        if mm:
            latest_more_actions = re.sub(r"\s+", " ", mm.group(1)).strip()

        am = ACTION_LINE_RE.match(s)
        if am and not RUNNING_TASK_RE.match(s):
            verb = am.group(1).strip()
            param = CTRL_O_SUFFIX_RE.sub("", am.group(2)).strip()
            param = re.sub(r"\s+", " ", param)
            if "/api/sessions/" in param:
                continue
            if param:
                actions.append({"action": verb, "parameter": param[:300]})

    is_running = bool(has_esc_cancel or raw_spinner_text or running_task)
    is_idle = bool(has_shortcuts and not is_running and not has_loading_spinner)

    status_parts: list[str] = []
    if is_running:
        if running_task and raw_spinner_text:
            status_parts.append(f"运行命令 `{running_task[:120]}` · {raw_spinner_text}")
        elif running_task:
            status_parts.append(f"运行命令 `{running_task[:160]}`")
        elif raw_spinner_text:
            status_parts.append(raw_spinner_text)
        elif latest_thought:
            tail_info = f" ({latest_more_actions})" if latest_more_actions else ""
            status_parts.append(f"Thought for {latest_thought}{tail_info}")
        elif has_esc_cancel:
            status_parts.append("云端执行中")

    status_text = " ".join(status_parts).strip()[:240]
    final_text = _extract_final_text(content_lines) if is_idle else ""

    return {
        "isRunning": is_running,
        "isIdle": is_idle,
        "statusText": status_text,
        "runningTask": running_task,
        "actions": actions,
        "finalText": final_text,
    }


def _emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Read-only stream watcher for an active `agy --remote-agent` conversation"
    )
    parser.add_argument("--agy-bin", default="agy")
    parser.add_argument("--conversation", required=True)
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--poll-interval", type=float, default=2.0)
    parser.add_argument("--idle-confirm-seconds", type=float, default=8.0)
    parser.add_argument("--max-seconds", type=float, default=7200.0)
    args = parser.parse_args()

    stop_requested = False

    def _on_signal(_signum, _frame) -> None:
        nonlocal stop_requested
        stop_requested = True

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    try:
        with PtySession(
            agy_bin=args.agy_bin,
            cwd=args.cwd,
            extra_args=["--conversation", args.conversation],
            rows=60,
            cols=140,
        ) as sess:
            sess.wait_log(
                rf"Streaming conversation {re.escape(args.conversation)}", timeout=45.0
            )
            sess.pump(2.5)
            if stop_requested:
                return 0

            initial = extract_snapshot(sess.term.lines())
            _emit(
                {
                    "event": "attached",
                    "conversationId": args.conversation,
                    "running": initial["isRunning"],
                }
            )

            seen_actions: set[tuple[str, str]] = set()
            for item in initial["actions"]:
                seen_actions.add((item["action"], item["parameter"]))

            if initial["isRunning"]:
                if initial["actions"]:
                    last_act = initial["actions"][-1]
                    _emit(
                        {
                            "event": "action",
                            "action": last_act["action"],
                            "parameter": last_act["parameter"],
                        }
                    )
                if initial["statusText"]:
                    _emit(
                        {
                            "event": "status",
                            "text": initial["statusText"],
                            "running": True,
                        }
                    )

            attached_at = time.monotonic()
            last_status = initial["statusText"] if initial["isRunning"] else ""
            idle_since: float | None = (
                attached_at if initial["isIdle"] else None
            )

            while not stop_requested:
                now = time.monotonic()
                if now - attached_at >= args.max_seconds:
                    _emit({"event": "timeout", "conversationId": args.conversation})
                    return 0

                if sess.proc is not None and sess.proc.poll() is not None:
                    _emit(
                        {
                            "event": "eof",
                            "conversationId": args.conversation,
                            "exitCode": sess.proc.returncode,
                        }
                    )
                    return 0

                sess.pump(args.poll_interval)
                if stop_requested:
                    return 0

                snap = extract_snapshot(sess.term.lines())
                for item in snap["actions"]:
                    key = (item["action"], item["parameter"])
                    if key not in seen_actions:
                        seen_actions.add(key)
                        _emit(
                            {
                                "event": "action",
                                "action": item["action"],
                                "parameter": item["parameter"],
                            }
                        )

                if snap["isRunning"] and snap["statusText"] and snap["statusText"] != last_status:
                    last_status = snap["statusText"]
                    _emit(
                        {
                            "event": "status",
                            "text": snap["statusText"],
                            "running": True,
                        }
                    )

                now = time.monotonic()
                if snap["isIdle"]:
                    if idle_since is None:
                        idle_since = now
                    if (
                        now - idle_since >= args.idle_confirm_seconds
                        and now - attached_at >= 8.0
                    ):
                        _emit(
                            {
                                "event": "idle",
                                "conversationId": args.conversation,
                                "finalText": snap["finalText"],
                            }
                        )
                        return 0
                else:
                    idle_since = None
    except Exception as exc:
        _emit(
            {
                "event": "error",
                "conversationId": args.conversation,
                "error": str(exc),
            }
        )
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
