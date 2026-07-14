"""
KOVIX :: Executor
==================
Runs generated scripts in the workspace directory via subprocess and captures
stdout, stderr, and return code. Platform-safe (Windows + Linux).
"""
from __future__ import annotations

import os
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional


@dataclass
class ExecutionResult:
    """Structured result of a subprocess execution."""
    returncode: int
    stdout: str
    stderr: str
    command: str
    cwd: str
    duration_s: float

    @property
    def success(self) -> bool:
        return self.returncode == 0

    def to_dict(self) -> Dict[str, object]:
        return {
            "returncode": self.returncode,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "command": self.command,
            "cwd": self.cwd,
            "duration_s": self.duration_s,
            "success": self.success,
        }


def _build_command(entrypoint: str, workspace_dir: Path) -> List[str]:
    """Parse an entrypoint string like 'python main_demo.py' into argv.

    On all platforms, resolve 'python'/'python3'/'py' to the currently
    running interpreter so the spawned subprocess uses the same env.
    """
    posix_mode: bool = os.name != "nt"
    tokens: List[str] = shlex.split(entrypoint, posix=posix_mode)
    if not tokens:
        raise ValueError(f"Empty entrypoint: {entrypoint!r}")

    head: str = tokens[0].lower()
    if head in ("python", "python3", "py"):
        tokens[0] = sys.executable or tokens[0]
    # 'node' is left as-is; it must be on PATH.
    return tokens


def execute(
    entrypoint: str,
    workspace_dir: Path,
    timeout_s: float = 60.0,
    env_overrides: Optional[Dict[str, str]] = None,
) -> ExecutionResult:
    """Execute `entrypoint` inside `workspace_dir` and capture all output."""
    workspace_dir.mkdir(parents=True, exist_ok=True)
    argv: List[str] = _build_command(entrypoint, workspace_dir)

    env: Dict[str, str] = dict(os.environ)
    if env_overrides:
        env.update(env_overrides)
    env.setdefault("PYTHONUNBUFFERED", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")

    t0: float = time.perf_counter()
    try:
        proc: subprocess.CompletedProcess = subprocess.run(
            argv,
            cwd=str(workspace_dir),
            capture_output=True,
            text=True,
            timeout=timeout_s,
            env=env,
            shell=False,
        )
        elapsed: float = time.perf_counter() - t0
        return ExecutionResult(
            returncode=proc.returncode,
            stdout=proc.stdout or "",
            stderr=proc.stderr or "",
            command=" ".join(argv),
            cwd=str(workspace_dir),
            duration_s=elapsed,
        )
    except subprocess.TimeoutExpired as exc:
        elapsed = time.perf_counter() - t0
        out_str: str = ""
        if isinstance(exc.stdout, bytes):
            out_str = exc.stdout.decode("utf-8", errors="replace")
        elif isinstance(exc.stdout, str):
            out_str = exc.stdout
        err_str: str = ""
        if isinstance(exc.stderr, bytes):
            err_str = exc.stderr.decode("utf-8", errors="replace")
        elif isinstance(exc.stderr, str):
            err_str = exc.stderr
        return ExecutionResult(
            returncode=-1,
            stdout=out_str,
            stderr=f"[KOVIX] execution timed out after {timeout_s}s\n" + err_str,
            command=" ".join(argv),
            cwd=str(workspace_dir),
            duration_s=elapsed,
        )
    except FileNotFoundError as exc:
        elapsed = time.perf_counter() - t0
        return ExecutionResult(
            returncode=127,
            stdout="",
            stderr=f"[KOVIX] executable not found: {exc}\n",
            command=" ".join(argv),
            cwd=str(workspace_dir),
            duration_s=elapsed,
        )
