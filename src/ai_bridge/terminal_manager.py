"""Interactive Live Terminal (PTY on Linux / ConPTY on Windows).

Provides high-performance, real-time terminal streaming over SSE:
- Linux: Full pseudo-terminal via pty.openpty() with ANSI color support, job control, signals.
- Windows: Prefer ConPTY (CreatePseudoConsole) for interactive PowerShell; fall back to pipes.
- SSE Stream Broadcaster: Real-time chunk delivery to browser dashboard with replay buffer.
- Bi-directional interactive input: keystrokes, Ctrl+C, tab completion, command execution.
"""
from __future__ import annotations

import os
import platform
import queue
import signal
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Generator

_TERMINAL_SESSIONS: dict[str, "TerminalSession"] = {}
_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# F-04-07 — one shell contract for this module.
#
# Divergent shell paths in the tree: tools._run_argv (argv, clean env,
# kill() on timeout, no process-group SIGKILL), execution.TaskRunner
# (allowlisted registry only, SIGTERM-only _kill), and this module's
# interactive PTY spawn. This module must NOT duplicate execution.py's
# allowlisted registry — interactive terminal input is by design arbitrary
# shell text. What it DOES own is one contract for *how* a shell process
# is spawned and killed here: argv form (never shell=True), a minimal
# scrubbed env, a timeout, and SIGTERM -> grace -> SIGKILL on the whole
# process group (F-04-11). Non-interactive one-shot execution in this
# module goes through run_shell_command() only.
# ---------------------------------------------------------------------------

#: Env keys that must never leak into a child shell (F-04-07 / SEC-07).
SHELL_SECRET_ENV_KEYS = frozenset({
    "AI_BRIDGE_ADMIN_TOKEN", "AI_BRIDGE_DEVICE_TOKEN",
    "AI_BRIDGE_OIDC_CLIENT_SECRET", "AI_BRIDGE_CSRF_SECRET",
    "AI_BRIDGE_MCP_TOKEN_KEY", "DATABASE_URL",
})

#: Minimal allowlist for a child shell environment (mirrors execution.py).
SHELL_ENV_ALLOWLIST = frozenset({
    "PATH", "HOME", "LANG", "LC_ALL", "TERM", "COLORTERM", "SHELL",
    "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP",
})


def clean_shell_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Build the minimal env for a child shell: allowlist + scrub secrets."""
    env = {k: v for k, v in os.environ.items()
           if k in SHELL_ENV_ALLOWLIST and k not in SHELL_SECRET_ENV_KEYS}
    env.setdefault("TERM", "xterm-256color")
    if os.name == "nt":
        for k in ("SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
                  "USERPROFILE", "LOCALAPPDATA", "APPDATA"):
            if k in os.environ:
                env[k] = os.environ[k]
    if extra:
        for k, v in extra.items():
            if k not in SHELL_SECRET_ENV_KEYS and v is not None:
                env[k] = str(v)
    return env


def terminate_process_group(proc: Any, grace_seconds: float = 2.0) -> None:
    """F-04-11 — SIGTERM, grace period, then SIGKILL the process group.

    Works for subprocess.Popen and the ConPTY wrapper (which exposes
    terminate()/kill()/poll()). Never reports success while the process
    may still be alive: after SIGKILL we wait again, and a still-running
    process is left for the caller to observe via poll().
    """
    if proc is None:
        return
    try:
        if os.name == "nt":
            try:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                               shell=False, capture_output=True, timeout=5)
                return
            except Exception:
                pass
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except Exception:
            try:
                proc.terminate()
            except Exception:
                pass
        deadline = time.time() + max(0.0, float(grace_seconds))
        while time.time() < deadline:
            if proc.poll() is not None:
                return
            time.sleep(0.05)
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            try:
                proc.wait(timeout=5)
            except Exception:
                pass
    except Exception:
        pass


@dataclass
class ShellSpec:
    """One shell contract (F-04-07): argv only, clean env, timeout, kill grace."""
    argv: list[str]
    cwd: str | None = None
    timeout: float = 60.0
    env_extra: dict[str, str] | None = None
    kill_grace_seconds: float = 2.0
    text: bool = True


def run_shell_command(spec: ShellSpec) -> dict[str, Any]:
    """Run one non-interactive shell command under the shell contract.

    - argv list only (``shell=False``); an empty argv is rejected.
    - new process group (``start_new_session``) so the kill escalates
      to the whole group, including children the command spawned.
    - minimal scrubbed env from :func:`clean_shell_env`.
    - timeout -> SIGTERM, grace, SIGKILL (F-04-11), ``timed_out: True``.
    - output truncated to 20_000 chars.
    This is the single entry point for one-shot shell execution in this
    module; interactive PTY sessions use the same env + kill helpers.
    """
    if not spec.argv or not all(isinstance(a, str) and a for a in spec.argv):
        raise ValueError("ShellSpec.argv must be a non-empty list of strings.")
    timeout = max(1.0, min(float(spec.timeout), 3600.0))
    proc = subprocess.Popen(
        list(spec.argv),
        shell=False,
        cwd=spec.cwd,
        env=clean_shell_env(spec.env_extra),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=spec.text,
        start_new_session=(os.name != "nt"),
    )
    try:
        out, err = proc.communicate(timeout=timeout)
        return {
            "returncode": proc.returncode,
            "stdout": (out or "")[-20000:],
            "stderr": (err or "")[-20000:],
            "timed_out": False,
        }
    except subprocess.TimeoutExpired:
        terminate_process_group(proc, grace_seconds=spec.kill_grace_seconds)
        try:
            out, err = proc.communicate(timeout=5)
        except Exception:
            out, err = "", ""
        return {
            "returncode": proc.returncode,
            "stdout": (out or "")[-20000:],
            "stderr": (f"command timed out after {timeout:g}s" + ("\n" + (err or "") if err else ""))[-20000:],
            "timed_out": True,
        }


# ---------------------------------------------------------------------------
# F-04-16 — bounded terminal sessions with TTL / eviction.
# ---------------------------------------------------------------------------

def max_terminal_sessions() -> int:
    try:
        return max(1, int(os.environ.get("AI_BRIDGE_MAX_TERMINAL_SESSIONS", "32")))
    except ValueError:
        return 32


def terminal_session_idle_ttl_seconds() -> float:
    try:
        return max(60.0, float(os.environ.get("AI_BRIDGE_TERMINAL_SESSION_IDLE_TTL_SEC", "1800")))
    except ValueError:
        return 1800.0


def terminal_session_limits() -> dict[str, Any]:
    """Report the active session bounds (for diagnostics / tests)."""
    with _LOCK:
        live = len(_TERMINAL_SESSIONS)
    return {
        "max_sessions": max_terminal_sessions(),
        "idle_ttl_seconds": terminal_session_idle_ttl_seconds(),
        "live_sessions": live,
    }


def prune_terminal_sessions(now: float | None = None) -> list[str]:
    """Evict dead sessions and sessions idle past the TTL; return evicted ids.

    Evicted sessions are closed (process group terminated) outside the
    lock. Called on create/get/list so the registry cannot grow
    unboundedly even if no caller ever closes a session explicitly.
    """
    now = time.time() if now is None else now
    ttl = terminal_session_idle_ttl_seconds()
    evicted: list[TerminalSession] = []
    with _LOCK:
        for sid, sess in list(_TERMINAL_SESSIONS.items()):
            idle = now - (sess.last_active or sess.created_at)
            if (not sess.is_alive) or idle > ttl:
                _TERMINAL_SESSIONS.pop(sid, None)
                evicted.append(sess)
    for sess in evicted:
        try:
            sess.close()
        except Exception:
            pass
    return [s.session_id for s in evicted]


def _evict_oldest_idle() -> str | None:
    """Evict (and close) the oldest idle live session. Returns its id or None."""
    with _LOCK:
        if not _TERMINAL_SESSIONS:
            return None
        oldest = min(_TERMINAL_SESSIONS.values(),
                     key=lambda s: (s.last_active or s.created_at))
        sid = oldest.session_id
        _TERMINAL_SESSIONS.pop(sid, None)
    try:
        oldest.close()
    except Exception:
        pass
    return sid


def _windows_conpty_available() -> bool:
    if platform.system() != "Windows":
        return False
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        return hasattr(kernel32, "CreatePseudoConsole")
    except Exception:
        return False


def _start_windows_conpty(cols: int, rows: int, env: dict[str, str]):
    """Spawn PowerShell attached to a ConPTY; return (proc, read_fd, write_fd, hpcon)."""
    import ctypes
    import msvcrt
    from ctypes import wintypes

    kernel32 = ctypes.windll.kernel32
    HPCON = wintypes.HANDLE
    SIZE = wintypes.COORD

    CreatePipe = kernel32.CreatePipe
    CreatePipe.argtypes = [ctypes.POINTER(wintypes.HANDLE), ctypes.POINTER(wintypes.HANDLE), wintypes.LPVOID, wintypes.DWORD]
    CreatePipe.restype = wintypes.BOOL
    CreatePseudoConsole = kernel32.CreatePseudoConsole
    CreatePseudoConsole.argtypes = [SIZE, wintypes.HANDLE, wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(HPCON)]
    CreatePseudoConsole.restype = wintypes.HRESULT
    CloseHandle = kernel32.CloseHandle
    SetHandleInformation = kernel32.SetHandleInformation
    HANDLE_FLAG_INHERIT = 0x00000001

    class STARTUPINFOEXW(ctypes.Structure):
        _fields_ = [
            ("StartupInfo", wintypes.STARTUPINFOW),
            ("lpAttributeList", wintypes.LPVOID),
        ]

    # Pipes: host reads output from out_read; host writes input to in_write.
    in_read = wintypes.HANDLE()
    in_write = wintypes.HANDLE()
    out_read = wintypes.HANDLE()
    out_write = wintypes.HANDLE()
    if not CreatePipe(ctypes.byref(in_read), ctypes.byref(in_write), None, 0):
        raise OSError("CreatePipe (stdin) failed")
    if not CreatePipe(ctypes.byref(out_read), ctypes.byref(out_write), None, 0):
        raise OSError("CreatePipe (stdout) failed")
    SetHandleInformation(in_write, HANDLE_FLAG_INHERIT, 0)
    SetHandleInformation(out_read, HANDLE_FLAG_INHERIT, 0)

    size = SIZE(cols, rows)
    hpcon = HPCON()
    hr = CreatePseudoConsole(size, in_read, out_write, 0, ctypes.byref(hpcon))
    if hr != 0:
        CloseHandle(in_read)
        CloseHandle(in_write)
        CloseHandle(out_read)
        CloseHandle(out_write)
        raise OSError(f"CreatePseudoConsole failed HRESULT=0x{hr & 0xFFFFFFFF:08X}")

    # Close ends duplicated into the console.
    CloseHandle(in_read)
    CloseHandle(out_write)

    # Launch powershell attached via PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE.
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016
    InitializeProcThreadAttributeList = kernel32.InitializeProcThreadAttributeList
    UpdateProcThreadAttribute = kernel32.UpdateProcThreadAttribute
    DeleteProcThreadAttributeList = kernel32.DeleteProcThreadAttributeList
    CreateProcessW = kernel32.CreateProcessW

    size_attr = ctypes.c_size_t(0)
    InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size_attr))
    attr_list = (ctypes.c_byte * size_attr.value)()
    if not InitializeProcThreadAttributeList(attr_list, 1, 0, ctypes.byref(size_attr)):
        kernel32.ClosePseudoConsole(hpcon)
        CloseHandle(in_write)
        CloseHandle(out_read)
        raise OSError("InitializeProcThreadAttributeList failed")
    if not UpdateProcThreadAttribute(
        attr_list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hpcon, ctypes.sizeof(hpcon), None, None
    ):
        DeleteProcThreadAttributeList(attr_list)
        kernel32.ClosePseudoConsole(hpcon)
        CloseHandle(in_write)
        CloseHandle(out_read)
        raise OSError("UpdateProcThreadAttribute failed")

    si = STARTUPINFOEXW()
    si.StartupInfo.cb = ctypes.sizeof(STARTUPINFOEXW)
    si.lpAttributeList = ctypes.cast(attr_list, wintypes.LPVOID)
    pi = wintypes.PROCESS_INFORMATION()
    cmdline = ctypes.create_unicode_buffer("powershell.exe -NoLogo -NoExit")
    EXTENDED_STARTUPINFO_PRESENT = 0x00080000
    CREATE_UNICODE_ENVIRONMENT = 0x00000400
    merged_env = dict(os.environ)
    if env:
        merged_env.update(env)
    env_items = "".join(f"{k}={v}\0" for k, v in merged_env.items() if "=" not in str(k) and v is not None) + "\0"
    env_buf = ctypes.create_unicode_buffer(env_items)
    ok = CreateProcessW(
        None,
        cmdline,
        None,
        None,
        False,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
        env_buf,
        None,
        ctypes.byref(si),
        ctypes.byref(pi),
    )
    DeleteProcThreadAttributeList(attr_list)
    if not ok:
        kernel32.ClosePseudoConsole(hpcon)
        CloseHandle(in_write)
        CloseHandle(out_read)
        raise OSError("CreateProcessW for ConPTY failed")

    # Convert HANDLEs to Python file descriptors for os.read/os.write.
    read_fd = msvcrt.open_osfhandle(out_read.value, os.O_RDONLY)
    write_fd = msvcrt.open_osfhandle(in_write.value, os.O_WRONLY)
    # Detach ownership from CloseHandle by clearing values we opened as fds.
    out_read.value = 0
    in_write.value = 0

    class _ConPtyProc:
        def __init__(self, process_handle, thread_handle):
            self._ph = process_handle
            self._th = thread_handle
            self.returncode = None
            self._closed = False

        def poll(self):
            if self._closed or not self._ph:
                return self.returncode
            # 259 = STILL_ACTIVE
            code = wintypes.DWORD()
            if kernel32.GetExitCodeProcess(self._ph, ctypes.byref(code)):
                if code.value != 259:
                    self.returncode = int(code.value)
                    return self.returncode
            return None

        def terminate(self):
            if not self._closed and self._ph:
                kernel32.TerminateProcess(self._ph, 1)

        def kill(self):
            self.terminate()

        def close(self):
            if self._closed:
                return
            self._closed = True
            if self._th:
                try:
                    CloseHandle(self._th)
                except Exception:
                    pass
                self._th = None
            if self._ph:
                try:
                    CloseHandle(self._ph)
                except Exception:
                    pass
                self._ph = None

        def __del__(self):
            self.close()

    proc = _ConPtyProc(pi.hProcess, pi.hThread)
    return proc, read_fd, write_fd, hpcon


class TerminalSession:
    """Manages an active interactive shell process and its real-time I/O streams."""

    def __init__(
        self,
        session_id: str,
        device_id: str = "local",
        cols: int = 120,
        rows: int = 35,
        remote_exec=None,
        device_label: str = "",
        device_os: str = "",
    ):
        self.session_id = session_id
        self.device_id = device_id
        self.cols = cols
        self.rows = rows
        self.remote_exec = remote_exec
        self.device_label = device_label or device_id
        self.device_os = device_os or ""
        self._is_remote = bool(remote_exec is not None and device_id and device_id != "local")
        self._is_windows_remote = "win" in self.device_os.lower()
        self._remote_cwd = ""
        self._line_buf = ""
        self.created_at = time.time()
        self.last_active = time.time()
        self.is_alive = True
        self.seq = 0
        self.buffer: list[dict] = []
        self._max_buffer = 1000
        self.subscribers: set[queue.Queue] = set()

        self.proc: subprocess.Popen | None = None
        self.master_fd: int | None = None
        self.slave_fd: int | None = None
        self._conpty = None
        self._backend = "unknown"

        self._start_process()

    def _prompt(self) -> str:
        cwd_disp = self._remote_cwd or ("~" if not self._is_windows_remote else "C:\\")
        if self._is_windows_remote:
            return f"PS {self.device_label} {cwd_disp}> "
        return f"{self.device_label}:{cwd_disp}$ "

    def _start_process(self):
        """Spawn the platform shell (PTY on Linux, piped PowerShell on Windows) or start Remote Agent Relay."""
        if self._is_remote:
            os_tag = f" ({self.device_os})" if self.device_os else ""
            self._broadcast(
                f"Connected to {self.device_label}{os_tag} via AI Bridge Agent Shell Relay.\r\n"
                f"{self._prompt()}"
            )
            return

        system = platform.system()

        if system == "Linux" or system == "Darwin":
            try:
                import pty

                self.master_fd, self.slave_fd = pty.openpty()

                # Set initial terminal size if termios available
                try:
                    import fcntl
                    import struct
                    import termios

                    winsize = struct.pack("HHHH", self.rows, self.cols, 0, 0)
                    fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, winsize)
                except Exception:
                    pass

                shell = os.environ.get("SHELL", "/bin/bash")
                if not os.path.exists(shell):
                    shell = "/bin/sh"

                # F-04-07: one shell contract — minimal scrubbed env.
                env = clean_shell_env()
                env["TERM"] = "xterm-256color"
                env["COLORTERM"] = "truecolor"

                self.proc = subprocess.Popen(
                    [shell, "-i"],
                    stdin=self.slave_fd,
                    stdout=self.slave_fd,
                    stderr=self.slave_fd,
                    close_fds=True,
                    env=env,
                )
                os.close(self.slave_fd)
                self.slave_fd = None

                reader = threading.Thread(target=self._pty_read_loop, daemon=True)
                reader.start()
                return
            except Exception:
                pass

        # F-04-07: one shell contract — minimal scrubbed env.
        env = clean_shell_env()
        env["TERM"] = "xterm-256color"

        # Windows ConPTY (preferred) — true interactive console for PowerShell.
        if system == "Windows" and _windows_conpty_available():
            try:
                proc, read_fd, write_fd, hpcon = _start_windows_conpty(self.cols, self.rows, env)
                self.proc = proc  # type: ignore[assignment]
                self.master_fd = read_fd
                self._conpty_write_fd = write_fd
                self._conpty = hpcon
                self._backend = "conpty"
                reader = threading.Thread(target=self._pty_read_loop, daemon=True)
                reader.start()
                self._broadcast("[ConPTY] Interactive PowerShell session ready.\r\n")
                return
            except Exception as exc:
                self._broadcast(f"[ConPTY unavailable → pipe fallback: {exc}]\r\n")

        # Fallback: piped PowerShell / shell
        shell_cmd = ["powershell.exe", "-NoLogo", "-NoExit", "-Command", "-"]
        if system != "Windows":
            shell_cmd = ["/bin/sh", "-i"]

        self.proc = subprocess.Popen(
            shell_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=False,
            bufsize=0,
            env=env,
        )
        self._backend = "pipe"

        reader = threading.Thread(target=self._pipe_read_loop, daemon=True)
        reader.start()

    def _broadcast(self, text: str):
        """Append to history buffer and notify active SSE subscribers."""
        self.last_active = time.time()
        self.seq += 1
        chunk = {"seq": self.seq, "text": text, "ts": self.last_active}

        with _LOCK:
            self.buffer.append(chunk)
            if len(self.buffer) > self._max_buffer:
                self.buffer.pop(0)

            dead_subs = set()
            for q in self.subscribers:
                try:
                    q.put_nowait(chunk)
                except Exception:
                    dead_subs.add(q)
            self.subscribers.difference_update(dead_subs)

    def _pty_read_loop(self):
        """Read output from Linux PTY master FD."""
        try:
            while self.is_alive and self.master_fd is not None:
                data = os.read(self.master_fd, 2048)
                if not data:
                    break
                text = data.decode("utf-8", errors="replace")
                self._broadcast(text)
        except Exception:
            pass
        finally:
            self.is_alive = False
            self._broadcast("\r\n[Session Disconnected]\r\n")

    def _pipe_read_loop(self):
        """Read output from piped subprocess."""
        try:
            while self.is_alive and self.proc and self.proc.stdout:
                data = self.proc.stdout.read(512)
                if not data:
                    break
                text = data.decode("utf-8", errors="replace")
                self._broadcast(text)
        except Exception:
            pass
        finally:
            self.is_alive = False
            self._broadcast("\r\n[Session Disconnected]\r\n")

    def _exec_remote_line(self, cmd: str):
        """Execute a submitted command line on the remote agent and broadcast output."""
        try:
            stripped = cmd.strip()
            if not stripped:
                self._broadcast(self._prompt())
                return
            if stripped.lower() in ("exit", "logout"):
                self._broadcast("logout\r\n[Session Disconnected]\r\n")
                self.is_alive = False
                return
            if stripped.startswith("cd ") or stripped == "cd":
                target_dir = stripped[3:].strip().strip('"').strip("'") if len(stripped) > 2 else ""
                probe_cmd = (
                    f'cd "{target_dir}" && pwd'
                    if (target_dir and not self._is_windows_remote)
                    else (
                        f'Set-Location -LiteralPath "{target_dir}"; (Get-Location).Path'
                        if (target_dir and self._is_windows_remote)
                        else ("pwd" if not self._is_windows_remote else "(Get-Location).Path")
                    )
                )
                res = self.remote_exec(self.device_id, probe_cmd, self._remote_cwd)
                out = str((res or {}).get("stdout") or "").strip()
                err = str((res or {}).get("stderr") or "").strip()
                rc = (res or {}).get("returncode", 0)
                if rc == 0 and out:
                    self._remote_cwd = out.splitlines()[-1].strip()
                elif err:
                    self._broadcast(f"{err}\r\n")
                self._broadcast(self._prompt())
                return

            res = self.remote_exec(self.device_id, stripped, self._remote_cwd)
            if isinstance(res, dict):
                stdout = str(res.get("stdout") or "")
                stderr = str(res.get("stderr") or "")
                combined = stdout
                if stderr:
                    combined = f"{combined.rstrip()}\r\n{stderr}" if combined.strip() else stderr
                if combined:
                    norm = combined.replace("\r\n", "\n").replace("\n", "\r\n")
                    if not norm.endswith("\r\n"):
                        norm += "\r\n"
                    self._broadcast(norm)
            elif res is not None:
                self._broadcast(f"{res}\r\n")
        except Exception as exc:
            self._broadcast(f"[Remote execution error: {exc}]\r\n")
        if self.is_alive:
            self._broadcast(self._prompt())

    def write(self, data: str):
        """Write user input to the terminal."""
        if not self.is_alive or not data:
            return
        self.last_active = time.time()

        if self._is_remote:
            for ch in data:
                if ch == "\x03":
                    self._line_buf = ""
                    self._broadcast(f"^C\r\n{self._prompt()}")
                elif ch == "\x04":
                    self._line_buf = ""
                    self._broadcast("^D\r\n[Session Disconnected]\r\n")
                    self.is_alive = False
                    return
                elif ch in ("\x7f", "\b"):
                    if self._line_buf:
                        self._line_buf = self._line_buf[:-1]
                elif ch in ("\r", "\n"):
                    cmd = self._line_buf
                    self._line_buf = ""
                    if cmd.strip():
                        self._broadcast(f"{cmd}\r\n")
                        threading.Thread(target=self._exec_remote_line, args=(cmd,), daemon=True).start()
                    else:
                        self._broadcast(f"\r\n{self._prompt()}")
                else:
                    self._line_buf += ch
            return

        raw = data.encode("utf-8", errors="replace")

        try:
            write_fd = getattr(self, "_conpty_write_fd", None)
            if write_fd is not None:
                os.write(write_fd, raw)
            elif self.master_fd is not None and self._backend != "conpty":
                os.write(self.master_fd, raw)
            elif self.proc and getattr(self.proc, "stdin", None):
                self.proc.stdin.write(raw)
                self.proc.stdin.flush()
        except Exception:
            self.is_alive = False

    def resize(self, cols: int, rows: int):
        """Resize terminal dimensions."""
        self.cols = max(20, cols)
        self.rows = max(5, rows)
        if self._conpty is not None and platform.system() == "Windows":
            try:
                import ctypes
                from ctypes import wintypes

                SIZE = wintypes.COORD
                ResizePseudoConsole = ctypes.windll.kernel32.ResizePseudoConsole
                ResizePseudoConsole.argtypes = [wintypes.HANDLE, SIZE]
                ResizePseudoConsole.restype = wintypes.HRESULT
                ResizePseudoConsole(self._conpty, SIZE(self.cols, self.rows))
            except Exception:
                pass
        elif self.master_fd is not None and platform.system() in ("Linux", "Darwin"):
            try:
                import fcntl
                import struct
                import termios

                winsize = struct.pack("HHHH", self.rows, self.cols, 0, 0)
                fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, winsize)
            except Exception:
                pass

    def stream(self, since_seq: int = 0) -> Generator[str, None, None]:
        """Generator yielding SSE formatted strings for real-time frontend streaming."""
        q = queue.Queue(maxsize=500)
        with _LOCK:
            # Replay history since requested sequence number
            for item in self.buffer:
                if item["seq"] > since_seq:
                    q.put_nowait(item)
            self.subscribers.add(q)

        try:
            import json

            # Initial greeting event
            yield f"data: {json.dumps({'type': 'init', 'session_id': self.session_id, 'cols': self.cols, 'rows': self.rows})}\n\n"

            while self.is_alive or not q.empty():
                try:
                    chunk = q.get(timeout=20.0)
                    yield f"data: {json.dumps(chunk)}\n\n"
                except queue.Empty:
                    # Keep-alive heartbeat comment
                    yield ": ping\n\n"
        finally:
            with _LOCK:
                self.subscribers.discard(q)

    def close(self):
        """Terminate the terminal process and clean up handles.

        F-04-11: SIGTERM, grace period, then SIGKILL the whole process
        group — a hung shell (or its children) cannot survive close().
        """
        self.is_alive = False
        try:
            if self.proc:
                terminate_process_group(self.proc, grace_seconds=2.0)
                if hasattr(self.proc, "close"):
                    self.proc.close()
        except Exception:
            pass

        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except Exception:
                pass
            self.master_fd = None
        write_fd = getattr(self, "_conpty_write_fd", None)
        if write_fd is not None:
            try:
                os.close(write_fd)
            except Exception:
                pass
            self._conpty_write_fd = None
        if self._conpty is not None and platform.system() == "Windows":
            try:
                import ctypes

                ctypes.windll.kernel32.ClosePseudoConsole(self._conpty)
            except Exception:
                pass
            self._conpty = None


# ============================================================================
# Manager API
# ============================================================================

def create_terminal_session(
    device_id: str = "local",
    cols: int = 120,
    rows: int = 35,
    remote_exec=None,
    device_label: str = "",
    device_os: str = "",
) -> TerminalSession:
    """Create a new live terminal session.

    F-04-16: bounded — idle/dead sessions are pruned first, and if the
    registry is at ``AI_BRIDGE_MAX_TERMINAL_SESSIONS`` the oldest idle
    session is evicted (and closed) before the new one is registered.
    """
    prune_terminal_sessions()
    if len(_TERMINAL_SESSIONS) >= max_terminal_sessions():
        _evict_oldest_idle()
    session_id = uuid.uuid4().hex[:12]
    sess = TerminalSession(
        session_id,
        device_id=device_id,
        cols=cols,
        rows=rows,
        remote_exec=remote_exec,
        device_label=device_label,
        device_os=device_os,
    )
    with _LOCK:
        _TERMINAL_SESSIONS[session_id] = sess
    return sess


def get_terminal_session(session_id: str) -> TerminalSession | None:
    """Retrieve an active terminal session."""
    prune_terminal_sessions()
    with _LOCK:
        return _TERMINAL_SESSIONS.get(session_id)


def close_terminal_session(session_id: str) -> bool:
    """Close and remove a terminal session."""
    with _LOCK:
        sess = _TERMINAL_SESSIONS.pop(session_id, None)
    if sess:
        sess.close()
        return True
    return False


def list_terminal_sessions(device_id: str | None = None) -> list[dict]:
    """List active terminal sessions."""
    prune_terminal_sessions()
    with _LOCK:
        results = []
        for s in _TERMINAL_SESSIONS.values():
            if device_id is None or s.device_id == device_id:
                results.append({
                    "session_id": s.session_id,
                    "device_id": s.device_id,
                    "is_alive": s.is_alive,
                    "created_at": s.created_at,
                    "last_active": s.last_active,
                    "cols": s.cols,
                    "rows": s.rows,
                })
        return results

