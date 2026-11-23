#!/usr/bin/env python3
"""Production PTY launcher for spawning or resuming isolated `agy --remote-agent` sessions."""

import argparse
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

ANSI_CSI_SGR_RE = re.compile(r"\x1b\[[0-9;?]*m")
ANSI_OSC_RE = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
ANSI_CURSOR_FWD_RE = re.compile(r"\x1b\[(\d*)C")
ANSI_CURSOR_POS_RE = re.compile(r"\x1b\[[0-9;]*[Hf]")
ANSI_OTHER_CSI_RE = re.compile(r"\x1b\[[0-9;?<>=!]*[A-Za-z@`]")
ANSI_SINGLE_ESC_RE = re.compile(r"\x1b[@-Z\\-_]|\x1b\([A-Za-z0-9]")
CTRL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
CONVERSATION_FLAG_RE = re.compile(
    r"--conversation=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)
LOCAL_CONV_RE = re.compile(
    r"Created conversation ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)
SEND_MSG_RE = re.compile(r"Sending user message to conversation", re.IGNORECASE)
CLOUD_SUMMARY_RE = re.compile(r"Cloud summaries:", re.IGNORECASE)
ACE_UVM_RE = re.compile(r"cloudproxy:\s+starting on ACE uVM\s+([A-Za-z0-9_-]+)", re.IGNORECASE)
CLOUD_FATAL_RE = re.compile(
    r"(RESOURCE_EXHAUSTED[^\n]*|Reached the limit of \d+ running environments[^\n]*|cloudproxy:[^\n]*(?:failed|error)[^\n]*)",
    re.IGNORECASE,
)
CLOUD_PROJECT_NOT_FOUND_RE = re.compile(
    r'Cloud project "([^"]+)" not found', re.IGNORECASE
)
USING_CLOUD_PROJECT_RE = re.compile(
    r'Using cloud project "([^"]+)" \(id=([0-9a-f-]+)\)', re.IGNORECASE
)


def strip_ansi(text: str) -> str:
    """Strip ANSI escape sequences into readable plain text."""
    text = ANSI_OSC_RE.sub("", text)
    text = ANSI_CSI_SGR_RE.sub("", text)
    text = ANSI_CURSOR_FWD_RE.sub(
        lambda m: " " * (int(m.group(1)) if m.group(1) else 1), text
    )
    text = ANSI_CURSOR_POS_RE.sub("\n", text)
    text = ANSI_OTHER_CSI_RE.sub("", text)
    text = ANSI_SINGLE_ESC_RE.sub("", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = CTRL_CHARS_RE.sub("", text)
    return text


def set_winsize(fd: int, rows: int = 40, cols: int = 120) -> None:
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def read_nonblocking(fd: int) -> bytes:
    chunks = []
    while True:
        try:
            data = os.read(fd, 65536)
            if not data:
                break
            chunks.append(data)
            if len(data) < 65536:
                break
        except OSError as exc:
            if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EIO):
                break
            raise
    return b"".join(chunks)


SECRET_LOG_RE = re.compile(
    r"(token|secret|bearer|oauth|cookie|credential|authorization)", re.IGNORECASE
)


def write_all_pty(
    master_fd: int, proc: subprocess.Popen[bytes], data: bytes, on_chunk, timeout: float = 10.0
) -> None:
    """Write all bytes to a non-blocking PTY master fd while draining child output."""
    view = memoryview(data)
    sent = 0
    deadline = time.monotonic() + timeout
    while sent < len(view):
        rc = proc.poll()
        if rc is not None:
            raise RuntimeError(f"agy exited early with code {rc}")
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Timed out writing {len(view)} bytes to PTY (sent {sent})")
        rlist, wlist, _ = select.select([master_fd], [master_fd], [], 0.1)
        if master_fd in rlist:
            raw = read_nonblocking(master_fd)
            if raw:
                on_chunk(raw)
        if master_fd in wlist:
            chunk = view[sent : sent + 256]
            try:
                written = os.write(master_fd, chunk)
                if written > 0:
                    sent += written
            except OSError as exc:
                if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    time.sleep(0.02)
                    continue
                if exc.errno == errno.EIO:
                    rc = proc.poll()
                    raise RuntimeError(f"agy PTY closed (EIO, exit={rc})") from exc
                raise


def write_text_pty(
    master_fd: int,
    proc: subprocess.Popen[bytes],
    text: str,
    use_bracketed_paste: bool,
    on_chunk,
) -> None:
    """Send UTF-8 text in 80-char chunks so multi-byte characters are never split."""
    if use_bracketed_paste:
        write_all_pty(master_fd, proc, b"\x1b[200~", on_chunk, timeout=5.0)
        body = text
    else:
        body = text.replace("\n", " ")

    for i in range(0, len(body), 80):
        chunk_bytes = body[i : i + 80].encode("utf-8")
        write_all_pty(master_fd, proc, chunk_bytes, on_chunk, timeout=10.0)
        pump_io(master_fd, proc, 0.03, on_chunk)

    if use_bracketed_paste:
        write_all_pty(master_fd, proc, b"\x1b[201~", on_chunk, timeout=5.0)


def pump_io(
    master_fd: int,
    proc: subprocess.Popen[bytes],
    duration: float,
    on_chunk,
) -> bool:
    """Pump PTY bytes for up to `duration` seconds; return True if process exited."""
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        ret = proc.poll()
        rlist, _, _ = select.select([master_fd], [], [], 0.1)
        if master_fd in rlist:
            raw = read_nonblocking(master_fd)
            if raw:
                on_chunk(raw)
        if ret is not None:
            for _ in range(3):
                raw = read_nonblocking(master_fd)
                if not raw:
                    break
                on_chunk(raw)
            return True
    return proc.poll() is not None


def terminate_process_group(pid: int) -> None:
    """Terminate and reap the child process group."""
    try:
        os.killpg(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        try:
            waited_pid, _ = os.waitpid(pid, os.WNOHANG)
            if waited_pid == pid:
                return
        except ChildProcessError:
            return
        time.sleep(0.1)
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        return


def read_log_safe(log_path: Path) -> str:
    if not log_path.exists():
        return ""
    return log_path.read_text(encoding="utf-8", errors="replace")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Launch or resume an isolated agy --remote-agent session via PTY"
    )
    parser.add_argument("--agy-bin", default="agy", help="Path or name of agy binary")
    parser.add_argument("--project", default="", help="Remote project ID or name for new session")
    parser.add_argument("--conversation", default="", help="Existing remote conversation ID to resume")
    parser.add_argument("--mode", default="accept-edits", help="Agent execution mode")
    parser.add_argument("--prompt-file", required=True, help="UTF-8 prompt text file")
    parser.add_argument("--log-file", required=True, help="Per-dispatch CLI log file path")
    parser.add_argument("--ready-timeout", type=float, default=45.0, help="Cloud readiness timeout (s)")
    parser.add_argument("--send-timeout", type=float, default=240.0, help="Prompt submission & cloud uVM timeout (s)")
    parser.add_argument("--idle-timeout", type=float, default=180.0, help="Wait timeout when not detaching (s)")
    parser.add_argument("--detach", dest="detach", action="store_true", default=True)
    parser.add_argument("--wait-idle", dest="detach", action="store_false")
    args = parser.parse_args()

    prompt_text = Path(args.prompt_file).read_text(encoding="utf-8").strip()
    if not prompt_text:
        print(json.dumps({"ok": False, "error": "Prompt file is empty"}))
        return 2

    log_path = Path(args.log_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    if log_path.exists():
        log_path.unlink()

    is_resume = bool(args.conversation)
    cmd = [args.agy_bin, "--log-file", str(log_path), "--remote-agent"]
    if is_resume:
        cmd.extend(["--conversation", args.conversation])
    elif args.project:
        cmd.extend(["--project", args.project])
    if args.mode:
        cmd.extend(["--mode", args.mode])

    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    env.setdefault("COLORTERM", "truecolor")

    master_fd, slave_fd = pty.openpty()
    set_winsize(slave_fd, rows=40, cols=120)
    os.set_blocking(master_fd, False)

    clean_buffer = ""
    bracketed_paste_seen = False
    start_time = time.monotonic()
    cloud_ready_at: float | None = None
    prompt_sent_at: float | None = None
    send_confirmed_at: float | None = None
    uvm_started_at: float | None = None
    ace_uvm_id: str | None = None
    uvm_end_offset: int | None = None
    cloud_confirmed_at: float | None = None
    ctrl_d_ignored = False
    detached_with_sigterm = False
    exit_code: int | None = None
    error_message: str | None = None
    proc: subprocess.Popen[bytes] | None = None

    if is_resume:
        wait_ready_re = re.compile(
            rf"Streaming conversation {re.escape(args.conversation)}", re.IGNORECASE
        )
        settle_seconds = 1.5
    else:
        wait_ready_re = re.compile(r"Cloud projects:")
        settle_seconds = 2.0

    def handle_chunk(raw: bytes) -> None:
        nonlocal clean_buffer, bracketed_paste_seen
        if b"\x1b[?2004h" in raw:
            bracketed_paste_seen = True
        if b"\x1b[6n" in raw:
            for _ in range(raw.count(b"\x1b[6n")):
                try:
                    os.write(master_fd, b"\x1b[1;1R")
                except OSError:
                    break
        if b"\x1b[5n" in raw:
            try:
                os.write(master_fd, b"\x1b[0n")
            except OSError:
                pass
        clean_buffer += strip_ansi(raw.decode("utf-8", errors="replace"))

    try:
        proc = subprocess.Popen(
            cmd,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env=env,
            start_new_session=True,
            close_fds=True,
        )
        os.close(slave_fd)
        slave_fd = -1

        # Phase 1: Wait for remote project / conversation readiness in log
        ready_deadline = start_time + args.ready_timeout
        while time.monotonic() < ready_deadline:
            exited = pump_io(master_fd, proc, 0.2, handle_chunk)
            log_now = read_log_safe(log_path)
            if wait_ready_re.search(log_now):
                cloud_ready_at = time.monotonic() - start_time
                break
            if exited:
                error_message = "agy exited before cloud readiness"
                break
        else:
            error_message = f"Timed out after {args.ready_timeout}s waiting for cloud readiness"

        if error_message is None and proc.poll() is None:
            pump_io(master_fd, proc, settle_seconds, handle_chunk)
            if not is_resume and args.project:
                log_after_ready = read_log_safe(log_path)
                if (
                    CLOUD_PROJECT_NOT_FOUND_RE.search(log_after_ready)
                    or "Project Not Found" in clean_buffer
                ):
                    error_message = (
                        f'Antigravity Remote Project "{args.project}" not found '
                        "(refused fallback to default project)"
                    )
        if error_message is None and proc.poll() is None:
            recent_screen = clean_buffer[-2000:]
            if "Do you trust the contents of this project?" in recent_screen or "Yes, I trust this folder" in recent_screen:
                write_all_pty(master_fd, proc, b"\r", handle_chunk, timeout=5.0)
                pump_io(master_fd, proc, 1.0, handle_chunk)
                recent_screen = clean_buffer[-2000:]
            # Dismiss startup promo modal only when actually shown
            if "esc to dismiss" in recent_screen.lower():
                write_all_pty(master_fd, proc, b"\x1b", handle_chunk, timeout=5.0)
                pump_io(master_fd, proc, 0.4, handle_chunk)

            # Capture log length right before submitting prompt
            log_offset_before_send = len(read_log_safe(log_path))

            write_text_pty(master_fd, proc, prompt_text, bracketed_paste_seen, handle_chunk)
            pump_io(master_fd, proc, 0.35, handle_chunk)
            write_all_pty(master_fd, proc, b"\r", handle_chunk, timeout=5.0)
            prompt_sent_at = time.monotonic() - start_time

            # Phase 2: Wait for confirmation that Google backend received the message & booted cloud uVM
            send_deadline = time.monotonic() + args.send_timeout
            send_end_offset = None
            while time.monotonic() < send_deadline:
                exited = pump_io(master_fd, proc, 0.2, handle_chunk)
                log_tail = read_log_safe(log_path)[log_offset_before_send:]
                if send_confirmed_at is None:
                    send_match = SEND_MSG_RE.search(log_tail)
                    if send_match is not None:
                        send_confirmed_at = time.monotonic() - start_time
                        send_end_offset = send_match.end()
                if send_end_offset is not None:
                    if not is_resume:
                        post_send_tail = log_tail[send_end_offset:]
                        for tail_line in post_send_tail.splitlines():
                            if "no uvm ahead" in tail_line.lower():
                                continue
                            fatal_match = CLOUD_FATAL_RE.search(tail_line)
                            if fatal_match is not None:
                                error_message = (
                                    "Cloud remote agent startup failed: "
                                    + fatal_match.group(1).strip()
                                )
                                break
                        if error_message is not None:
                            break

                        if uvm_end_offset is None:
                            uvm_match = ACE_UVM_RE.search(log_tail, send_end_offset)
                            if uvm_match is not None:
                                ace_uvm_id = uvm_match.group(1)
                                uvm_started_at = time.monotonic() - start_time
                                uvm_end_offset = uvm_match.end()

                        if uvm_end_offset is not None and cloud_confirmed_at is None:
                            uvm_elapsed = (time.monotonic() - start_time) - uvm_started_at
                            if (
                                CLOUD_SUMMARY_RE.search(log_tail, uvm_end_offset)
                                and uvm_elapsed >= 6.0
                            ) or uvm_elapsed >= 8.0:
                                cloud_confirmed_at = time.monotonic() - start_time
                                break
                    else:
                        if (
                            cloud_confirmed_at is None
                            and CLOUD_SUMMARY_RE.search(log_tail, send_end_offset)
                        ):
                            cloud_confirmed_at = time.monotonic() - start_time
                            break
                        if (
                            send_confirmed_at is not None
                            and (time.monotonic() - start_time) - send_confirmed_at >= 3.0
                        ):
                            cloud_confirmed_at = time.monotonic() - start_time
                            break
                if exited:
                    break

            if error_message is None and send_confirmed_at is None:
                error_message = "Prompt was injected into PTY but Sending user message was not observed in log"
            elif error_message is None and not is_resume and uvm_started_at is None:
                error_message = (
                    "Prompt was sent locally, but cloud ACE uVM startup was not "
                    f"observed within {args.send_timeout}s"
                )

        # Phase 3: Detach or wait for idle completion
        if proc.poll() is None:
            if args.detach and error_message is None:
                pump_io(master_fd, proc, 2.5, handle_chunk)
            elif not args.detach and error_message is None:
                idle_deadline = time.monotonic() + args.idle_timeout
                while time.monotonic() < idle_deadline:
                    if pump_io(master_fd, proc, 0.25, handle_chunk):
                        break
                    log_now = read_log_safe(log_path)
                    if "Stopping conversation stream" in log_now or "Stream goroutine exited" in log_now:
                        pump_io(master_fd, proc, 1.5, handle_chunk)
                        break

            # Send double Ctrl-D WITHOUT Esc so we do not cancel active cloud generation
            try:
                os.write(master_fd, b"\x04")
            except OSError:
                pass
            if not pump_io(master_fd, proc, 0.4, handle_chunk):
                try:
                    os.write(master_fd, b"\x04")
                except OSError:
                    pass
                if not pump_io(master_fd, proc, 5.0, handle_chunk):
                    ctrl_d_ignored = True
                    detached_with_sigterm = True
                    terminate_process_group(proc.pid)

        if proc.poll() is None:
            terminate_process_group(proc.pid)
        exit_code = proc.wait(timeout=5)
        raw = read_nonblocking(master_fd)
        if raw:
            handle_chunk(raw)

    except Exception as exc:
        error_message = str(exc)
    finally:
        if slave_fd >= 0:
            try:
                os.close(slave_fd)
            except OSError:
                pass
        try:
            os.close(master_fd)
        except OSError:
            pass
        if proc is not None and proc.poll() is None:
            terminate_process_group(proc.pid)
            try:
                exit_code = proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                exit_code = -9

    log_final = read_log_safe(log_path)
    conv_matches = CONVERSATION_FLAG_RE.findall(clean_buffer)
    conversation_id = conv_matches[-1] if conv_matches else (args.conversation or None)
    local_matches = LOCAL_CONV_RE.findall(log_final)
    local_proxy_id = local_matches[-1] if local_matches else None
    using_matches = USING_CLOUD_PROJECT_RE.findall(log_final)
    resolved_project_name = using_matches[-1][0] if using_matches else None
    resolved_project_id = using_matches[-1][1] if using_matches else None

    result = {
        "ok": error_message is None,
        "mode": "resume" if is_resume else "new",
        "conversationId": conversation_id,
        "localProxyId": local_proxy_id,
        "aceUvmId": ace_uvm_id,
        "remoteProject": args.project or None,
        "resolvedRemoteProjectName": resolved_project_name,
        "resolvedRemoteProjectId": resolved_project_id,
        "detached": bool(args.detach),
        "ctrlDIgnored": ctrl_d_ignored,
        "detachedWithSigterm": detached_with_sigterm,
        "exitCode": exit_code,
        "bracketedPasteSeen": bracketed_paste_seen,
        "logFile": str(log_path),
        "error": error_message,
        "timings": {
            "cloudReadySeconds": round(cloud_ready_at, 2) if cloud_ready_at is not None else None,
            "promptSentSeconds": round(prompt_sent_at, 2) if prompt_sent_at is not None else None,
            "sendConfirmedSeconds": round(send_confirmed_at, 2) if send_confirmed_at is not None else None,
            "uvmStartedSeconds": round(uvm_started_at, 2) if uvm_started_at is not None else None,
            "cloudConfirmedSeconds": round(cloud_confirmed_at, 2) if cloud_confirmed_at is not None else None,
            "totalSeconds": round(time.monotonic() - start_time, 2),
        },
    }
    if error_message is not None:
        safe_lines = [
            line for line in log_final.splitlines() if not SECRET_LOG_RE.search(line)
        ]
        result["logTail"] = "\n".join(safe_lines[-15:])
        result["ptyTail"] = clean_buffer[-500:]

    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
