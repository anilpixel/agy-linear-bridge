#!/usr/bin/env python3
"""Idempotently provision Antigravity Remote Projects linked to GitHub repositories via PTY."""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path

USING_CLOUD_PROJECT_RE = re.compile(
    r'Using cloud project "([^"]+)" \(id=([0-9a-f-]+)\)', re.IGNORECASE
)
CLOUD_PROJECT_NOT_FOUND_RE = re.compile(
    r'Cloud project "([^"]+)" not found', re.IGNORECASE
)
CHECKED_MARK_RE = re.compile(r"(\[[^\s\]]\]|[☑✓✔●])")


class MiniTerm:
    """Minimal ANSI virtual terminal grid for inspecting rendered TUI screens."""

    def __init__(self, rows: int = 50, cols: int = 140) -> None:
        self.rows = rows
        self.cols = cols
        self.grid = [[" "] * cols for _ in range(rows)]
        self.r = 0
        self.c = 0
        self.partial = ""

    def feed(self, text: str) -> None:
        s = self.partial + text
        self.partial = ""
        i = 0
        n = len(s)
        while i < n:
            ch = s[i]
            if ch == "\x1b":
                if i + 1 >= n:
                    self.partial = s[i:]
                    break
                nxt = s[i + 1]
                if nxt == "[":
                    m = re.match(r"\x1b\[([0-9;?=<>\s]*)([A-Za-z@`])", s[i:])
                    if not m:
                        if n - i < 32:
                            self.partial = s[i:]
                            break
                        i += 2
                        continue
                    params, cmd = m.group(1), m.group(2)
                    nums = [int(x) for x in re.findall(r"\d+", params)]
                    if cmd in ("H", "f"):
                        self.r = max(
                            0, min(self.rows - 1, (nums[0] - 1 if len(nums) >= 1 else 0))
                        )
                        self.c = max(
                            0, min(self.cols - 1, (nums[1] - 1 if len(nums) >= 2 else 0))
                        )
                    elif cmd == "A":
                        self.r = max(0, self.r - (nums[0] if nums else 1))
                    elif cmd == "B":
                        self.r = min(self.rows - 1, self.r + (nums[0] if nums else 1))
                    elif cmd == "C":
                        self.c = min(self.cols - 1, self.c + (nums[0] if nums else 1))
                    elif cmd == "D":
                        self.c = max(0, self.c - (nums[0] if nums else 1))
                    elif cmd == "G":
                        self.c = max(0, min(self.cols - 1, (nums[0] - 1 if nums else 0)))
                    elif cmd == "J":
                        mode = nums[0] if nums else 0
                        if mode == 2:
                            self.grid = [[" "] * self.cols for _ in range(self.rows)]
                        elif mode == 0:
                            for col in range(self.c, self.cols):
                                self.grid[self.r][col] = " "
                            for row in range(self.r + 1, self.rows):
                                self.grid[row] = [" "] * self.cols
                    elif cmd == "K":
                        mode = nums[0] if nums else 0
                        if mode == 0:
                            for col in range(self.c, self.cols):
                                self.grid[self.r][col] = " "
                        elif mode == 1:
                            for col in range(0, min(self.c + 1, self.cols)):
                                self.grid[self.r][col] = " "
                        elif mode == 2:
                            self.grid[self.r] = [" "] * self.cols
                    elif cmd == "P":
                        count = nums[0] if nums else 1
                        row = self.grid[self.r]
                        del row[self.c : min(self.cols, self.c + count)]
                        row.extend([" "] * (self.cols - len(row)))
                    i += len(m.group(0))
                elif nxt == "]":
                    end = s.find("\x07", i + 2)
                    end2 = s.find("\x1b\\", i + 2)
                    if end == -1 and end2 == -1:
                        if n - i < 256:
                            self.partial = s[i:]
                            break
                        i += 2
                    elif end != -1 and (end2 == -1 or end < end2):
                        i = end + 1
                    else:
                        i = end2 + 2
                else:
                    i += 2
            elif ch == "\r":
                self.c = 0
                i += 1
            elif ch == "\n":
                if self.r < self.rows - 1:
                    self.r += 1
                else:
                    self.grid = self.grid[1:] + [[" "] * self.cols]
                i += 1
            elif ch == "\b":
                self.c = max(0, self.c - 1)
                i += 1
            elif ord(ch) >= 32:
                if 0 <= self.r < self.rows and 0 <= self.c < self.cols:
                    self.grid[self.r][self.c] = ch
                self.c = min(self.cols - 1, self.c + 1)
                i += 1
            else:
                i += 1

    def lines(self) -> list[str]:
        return [
            line.rstrip()
            for line in ("".join(row) for row in self.grid)
            if line.strip()
        ]

    def render(self) -> str:
        return "\n".join(self.lines())


def terminate_process_group(pid: int) -> None:
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


class PtySession:
    """Context-managed `agy --remote-agent` PTY session."""

    def __init__(
        self,
        agy_bin: str,
        cwd: str,
        extra_args: list[str],
        rows: int = 50,
        cols: int = 140,
    ) -> None:
        self.agy_bin = agy_bin
        self.cwd = cwd
        self.extra_args = extra_args
        self.rows = rows
        self.cols = cols
        self.log_path = Path(tempfile.gettempdir()) / (
            f"agy_provision_{os.getpid()}_{time.monotonic_ns()}.log"
        )
        self.master_fd = -1
        self.proc: subprocess.Popen[bytes] | None = None
        self.term = MiniTerm(rows=rows, cols=cols)

    def __enter__(self) -> "PtySession":
        if self.log_path.exists():
            self.log_path.unlink()
        cmd = [self.agy_bin, "--log-file", str(self.log_path), "--remote-agent", *self.extra_args]
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env.setdefault("COLORTERM", "truecolor")
        mfd, sfd = pty.openpty()
        fcntl.ioctl(sfd, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, self.cols, 0, 0))
        os.set_blocking(mfd, False)
        self.master_fd = mfd
        self.proc = subprocess.Popen(
            cmd,
            cwd=self.cwd,
            stdin=sfd,
            stdout=sfd,
            stderr=sfd,
            env=env,
            start_new_session=True,
            close_fds=True,
        )
        os.close(sfd)
        return self

    def __exit__(self, *_exc) -> None:
        if self.proc is not None and self.proc.poll() is None:
            terminate_process_group(self.proc.pid)
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
        if self.master_fd >= 0:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = -1
        self.log_path.unlink(missing_ok=True)

    def pump(self, seconds: float) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            remaining = max(0.0, deadline - time.monotonic())
            rlist, _, _ = select.select([self.master_fd], [], [], min(0.1, remaining))
            if rlist:
                chunks = []
                while True:
                    try:
                        data = os.read(self.master_fd, 65536)
                        if not data:
                            break
                        if b"\x1b[6n" in data:
                            for _ in range(data.count(b"\x1b[6n")):
                                try:
                                    os.write(self.master_fd, b"\x1b[1;1R")
                                except OSError:
                                    break
                        if b"\x1b[5n" in data:
                            try:
                                os.write(self.master_fd, b"\x1b[0n")
                            except OSError:
                                pass
                        chunks.append(data)
                        if len(data) < 65536:
                            break
                    except OSError as exc:
                        if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EIO):
                            break
                        raise
                if chunks:
                    self.term.feed(b"".join(chunks).decode("utf-8", errors="replace"))

    def send_bytes(self, data: bytes) -> None:
        view = memoryview(data)
        sent = 0
        while sent < len(view):
            _, wlist, _ = select.select([], [self.master_fd], [], 2.0)
            if not wlist:
                raise TimeoutError("Timed out writing to PTY")
            try:
                n = os.write(self.master_fd, view[sent:])
                sent += n
            except OSError as exc:
                if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    self.pump(0.05)
                    continue
                raise

    def wait_log(self, pattern: str, timeout: float = 30.0) -> str:
        deadline = time.monotonic() + timeout
        regex = re.compile(pattern, re.IGNORECASE)
        while time.monotonic() < deadline:
            self.pump(0.2)
            txt = read_log_safe(self.log_path)
            if regex.search(txt):
                return txt
            if self.proc is not None and self.proc.poll() is not None:
                raise RuntimeError(f"agy exited early with code {self.proc.returncode}")
        raise TimeoutError(f"Timed out waiting for log pattern: {pattern}")


def probe_remote_project(agy_bin: str, project_name: str, cwd: str) -> str | None:
    """Return canonical cloud project UUID if `project_name` resolves without fallback, else None."""
    with PtySession(agy_bin=agy_bin, cwd=cwd, extra_args=["--project", project_name]) as sess:
        log_txt = sess.wait_log(r"(Using cloud project|Cloud project .* not found)", timeout=30.0)
        sess.pump(0.5)
        log_txt = read_log_safe(sess.log_path)
        if CLOUD_PROJECT_NOT_FOUND_RE.search(log_txt):
            return None
        for matched_name, matched_id in USING_CLOUD_PROJECT_RE.findall(log_txt):
            if matched_name.strip().lower() == project_name.strip().lower():
                return matched_id
        return None


def find_repo_line(lines: list[str], github_repo: str) -> str | None:
    token_re = re.compile(
        rf"(?:\[\s\]|\[[^\s\]]\])\s+{re.escape(github_repo)}(?:\s|$)",
        re.IGNORECASE,
    )
    for line in lines:
        if token_re.search(line):
            return line
    return None


def line_has_cursor(line: str) -> bool:
    stripped = line.lstrip()
    return stripped.startswith("> ") and bool(stripped[2:].strip())


def create_remote_project(
    agy_bin: str,
    project_name: str,
    github_repo: str,
) -> dict:
    """Create one Antigravity Remote Project linked to `github_repo` and verify its UUID."""
    parent_tmp = Path(tempfile.mkdtemp(prefix="agy-proj-"))
    proj_dir = parent_tmp / project_name
    proj_dir.mkdir(parents=True, exist_ok=True)
    try:
        existing_id = probe_remote_project(agy_bin, project_name, str(proj_dir))
        if existing_id:
            return {
                "name": project_name,
                "id": existing_id,
                "githubRepo": github_repo,
                "status": "existing",
            }

        with PtySession(agy_bin=agy_bin, cwd=str(proj_dir), extra_args=[]) as sess:
            sess.wait_log(r"Cloud projects:", timeout=30.0)
            ui_deadline = time.monotonic() + 6.0
            while time.monotonic() < ui_deadline:
                sess.pump(0.3)
                screen = sess.term.render()
                if (
                    "Do you trust the contents of this project?" in screen
                    or "Yes, I trust this folder" in screen
                ):
                    sess.send_bytes(b"\r")
                    sess.pump(1.2)
                    screen = sess.term.render()
                if "remote workspace" in screen or "Antigravity CLI" in screen:
                    break
            sess.pump(1.0)
            screen = sess.term.render()
            if "esc to dismiss" in screen.lower():
                sess.send_bytes(b"\x1b")
                sess.pump(0.4)

            sess.send_bytes(b"/projects")
            sess.pump(0.4)
            sess.send_bytes(b"\r")

            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline:
                sess.pump(0.25)
                if "+ New project..." in sess.term.render():
                    break
            else:
                raise RuntimeError(
                    f"Did not reach /projects modal for {project_name}:\n{sess.term.render()}"
                )

            sess.send_bytes(b"\r")
            deadline = time.monotonic() + 8.0
            while time.monotonic() < deadline:
                sess.pump(0.2)
                if "Project Name *" in sess.term.render():
                    break
            else:
                raise RuntimeError(
                    f"Did not reach New Project form for {project_name}:\n{sess.term.render()}"
                )

            screen = sess.term.render()
            if f"└─ {project_name}" not in screen:
                raise RuntimeError(
                    f"Pre-filled project name mismatch (expected '└─ {project_name}'):\n{screen}"
                )

            sess.send_bytes(b"\x1b[C")
            deadline = time.monotonic() + 12.0
            while time.monotonic() < deadline:
                sess.pump(0.25)
                lines = sess.term.lines()
                gh_line = next((l for l in lines if "GitHub" in l), "")
                if gh_line and "Connected" in gh_line and "Checking" not in gh_line:
                    break
            else:
                raise RuntimeError(
                    f"GitHub connection did not report Connected:\n{sess.term.render()}"
                )

            # Collapse Google Drive if currently selected & expanded so GitHub list stays visible
            drive_line = next((l for l in sess.term.lines() if "Google Drive" in l), "")
            if line_has_cursor(drive_line) and "▾" in drive_line:
                sess.send_bytes(b"\r")
                sess.pump(0.5)

            sess.send_bytes(github_repo.encode("utf-8"))
            sess.pump(1.2)

            # Ensure GitHub section is expanded if collapsed (`▸ GitHub`)
            for _ in range(4):
                gh_line = next((l for l in sess.term.lines() if "GitHub" in l), "")
                if "▾ GitHub" in gh_line:
                    break
                if line_has_cursor(gh_line) and "▸ GitHub" in gh_line:
                    sess.send_bytes(b"\r")
                    sess.pump(0.6)
                    break
                sess.send_bytes(b"\x1b[B")
                sess.pump(0.25)

            # Ensure Filter line rendered before inspecting list items
            sess.pump(0.4)

            # Move cursor step-by-step onto the exact target repo row, waiting for each redraw
            def picker_slice(lines_all: list[str]) -> list[str]:
                anchor = next(
                    (
                        idx
                        for idx, l in enumerate(lines_all)
                        if "Filter:" in l or "Type to filter resources" in l or "Connections" in l
                    ),
                    -1,
                )
                return lines_all[anchor + 1 :] if anchor >= 0 else lines_all

            def current_cursor_sig() -> str:
                return next(
                    (l.strip() for l in picker_slice(sess.term.lines()) if line_has_cursor(l)),
                    "",
                )

            target_selected = False
            for _ in range(25):
                lines_now = picker_slice(sess.term.lines())
                repo_line = find_repo_line(lines_now, github_repo)
                if repo_line and line_has_cursor(repo_line):
                    target_selected = True
                    break
                cur_sig = current_cursor_sig()
                cur_idx = next(
                    (idx for idx, l in enumerate(lines_now) if line_has_cursor(l)),
                    -1,
                )
                repo_idx = next(
                    (idx for idx, l in enumerate(lines_now) if l == repo_line),
                    -1,
                )
                key = b"\x1b[A" if (cur_idx >= 0 and repo_idx >= 0 and cur_idx > repo_idx) else b"\x1b[B"
                sess.send_bytes(key)
                move_deadline = time.monotonic() + 1.2
                while time.monotonic() < move_deadline:
                    sess.pump(0.1)
                    if current_cursor_sig() != cur_sig:
                        break

            if not target_selected:
                raise RuntimeError(
                    f"Could not select GitHub repo '{github_repo}' in Connections picker:\n{sess.term.render()}"
                )
            sess.pump(0.2)

            # Toggle checkbox (try Space first, fallback to Enter if still unchecked `[ ]`)
            sess.send_bytes(b" ")
            sess.pump(0.5)
            repo_line = find_repo_line(sess.term.lines(), github_repo) or ""
            if "[ ]" in repo_line:
                sess.send_bytes(b"\r")
                sess.pump(0.5)
                repo_line = find_repo_line(sess.term.lines(), github_repo) or ""

            if not repo_line or "[ ]" in repo_line or not CHECKED_MARK_RE.search(repo_line):
                sess.send_bytes(b"\x1b\x1b\x1b")
                sess.pump(0.3)
                raise RuntimeError(
                    f"Safety gate blocked creation: checkbox for '{github_repo}' is not checked (line={repo_line!r}):\n{sess.term.render()}"
                )

            # Ctrl+S to submit creation
            sess.send_bytes(b"\x13")
            deadline = time.monotonic() + 12.0
            while time.monotonic() < deadline:
                sess.pump(0.3)
                scr = sess.term.render()
                if "Projects › New Project" not in scr or f"● {project_name}" in scr:
                    break
            else:
                raise RuntimeError(
                    f"Timed out waiting for project '{project_name}' creation confirmation:\n{sess.term.render()}"
                )
            sess.pump(1.0)

        created_id = None
        for _attempt in range(3):
            created_id = probe_remote_project(agy_bin, project_name, str(proj_dir))
            if created_id:
                break
            time.sleep(1.0)

        if not created_id:
            raise RuntimeError(
                f"Created '{project_name}' via TUI, but follow-up `--project {project_name}` probe could not resolve its UUID"
            )

        return {
            "name": project_name,
            "id": created_id,
            "githubRepo": github_repo,
            "status": "created",
        }
    finally:
        shutil.rmtree(parent_tmp, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Provision Antigravity Remote Projects linked to GitHub repositories"
    )
    parser.add_argument("--agy-bin", default="agy")
    parser.add_argument("--spec", default="", help="JSON array of {name, repo} objects")
    parser.add_argument("--spec-file", default="", help="Path to JSON array file")
    parser.add_argument("--dry-run", action="store_true", help="Only probe existing projects without creating")
    args = parser.parse_args()

    if args.spec_file:
        specs = json.loads(Path(args.spec_file).read_text(encoding="utf-8"))
    elif args.spec:
        specs = json.loads(args.spec)
    else:
        raise SystemExit("Either --spec or --spec-file is required")

    results = []
    for item in specs:
        name = str(item["name"]).strip()
        repo = str(item["repo"]).strip()
        if args.dry_run:
            tmp = tempfile.mkdtemp(prefix="agy-dry-")
            try:
                existing_id = probe_remote_project(args.agy_bin, name, tmp)
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
            results.append(
                {
                    "name": name,
                    "id": existing_id,
                    "githubRepo": repo,
                    "status": "existing" if existing_id else "missing",
                }
            )
        else:
            res = create_remote_project(args.agy_bin, name, repo)
            print(f"[provision] {res['name']} -> {res['id']} ({res['status']})", file=sys.stderr, flush=True)
            results.append(res)

    print(json.dumps(results, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
