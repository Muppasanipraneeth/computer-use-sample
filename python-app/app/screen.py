"""The real screen, mouse and keyboard are one resource shared by every concurrent run. A single lock serialises the
steps that use them (clicks, typing, desktop screenshots, input release), so two runs never interleave inside a step.
Steps that only use the background instruments (read, web, apps) or plain Python run without waiting."""

from __future__ import annotations

import ast
import asyncio
import builtins
import contextlib
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from typing import Any

from .errors import RunnerCoreError
from .processes import await_active

# Words that mean the code may touch the screen, mouse, keyboard, clipboard or focus, however the code is written.
SCREEN_WORDS = re.compile(
    r"pyautogui|osascript|screencapture|open\s+-a\b|subprocess|os\s*\.\s*(?:system|popen|exec|spawn|startfile)"
    r"|ImageGrab|pynput|Quartz|AppKit|ctypes|webbrowser|pyperclip"
)
# Worker globals that never touch the screen: the background instruments and the output helpers.
SAFE_GLOBALS = frozenset({"read", "web", "apps", "log", "print", "display"})
# Standard modules for data, text, time and network work; anything else (os, sys, ...) counts as screen use.
SAFE_MODULES = frozenset({
    "base64", "binascii", "bisect", "calendar", "cmath", "collections", "copy", "csv", "dataclasses", "datetime",
    "decimal", "difflib", "email", "enum", "fractions", "functools", "hashlib", "heapq", "hmac", "html", "http",
    "io", "itertools", "json", "math", "operator", "pprint", "random", "re", "statistics", "string", "textwrap",
    "time", "typing", "unicodedata", "urllib", "uuid", "xml", "zoneinfo",
})
# Builtins that can reach any object in the worker (pyautogui included) or block on the terminal.
UNSAFE_BUILTINS = frozenset({"__import__", "breakpoint", "compile", "eval", "exec", "exit", "globals", "help", "input",
                             "locals", "quit", "vars"})
SAFE_BUILTINS = frozenset(name for name in dir(builtins) if not name.startswith("_")) - UNSAFE_BUILTINS


def _parse(code: str) -> ast.Module | None:
    try:
        return ast.parse(code)
    except (SyntaxError, ValueError):
        return None


def _bound_names(tree: ast.Module) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            names.add(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            names.update((alias.asname or alias.name).split(".")[0] for alias in node.names)
        elif isinstance(node, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar)) and node.name:
            names.add(node.name)
        elif isinstance(node, ast.MatchMapping) and node.rest:
            names.add(node.rest)
    return names


def _may_reach_screen(node: ast.AST, known: set[str] | frozenset[str]) -> bool:
    if isinstance(node, ast.Import):
        return any(alias.name.split(".")[0] not in SAFE_MODULES for alias in node.names)
    if isinstance(node, ast.ImportFrom):
        return bool(node.level) or (node.module or "").split(".")[0] not in SAFE_MODULES
    if isinstance(node, ast.Attribute):
        return node.attr.startswith("__")  # dunder walks reach any object, pyautogui included
    if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
        return node.id not in known and node.id not in SAFE_GLOBALS and node.id not in SAFE_BUILTINS
    return False


def uses_screen(code: str, safe_names: frozenset[str] | set[str] = frozenset()) -> bool:
    """True unless the code only uses read/web/apps/log/print/display, safe standard modules, builtins and names it
    or earlier screen-free steps (safe_names) bound. Conservative: anything unrecognised counts as screen use."""
    if SCREEN_WORDS.search(code):
        return True
    tree = _parse(code)
    if tree is None:
        return False  # A syntax error runs nothing.
    known = _bound_names(tree) | set(safe_names)
    return any(_may_reach_screen(node, known) for node in ast.walk(tree))


class ScreenLock:
    """One per runner. Reentrant per owner (a RunScreen), so a run's own input release inside its step can't
    deadlock; other runs wait."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._owner: object | None = None
        self._depth = 0
        self._last_owner: object | None = None
        self.disabled: str | None = None

    def disable(self, reason: str) -> None:
        """After a failed input release the desktop's input state is unknown: no run may use the screen again."""
        self.disabled = reason

    async def _acquire(self, signal: asyncio.Event | None) -> None:
        acquiring = asyncio.ensure_future(self._lock.acquire())
        try:
            await await_active(asyncio.shield(acquiring), signal)
        except BaseException:
            if not acquiring.done():
                acquiring.cancel()
            elif not acquiring.cancelled() and acquiring.exception() is None:
                self._lock.release()
            raise

    @contextlib.asynccontextmanager
    async def hold(self, owner: object, signal: asyncio.Event | None = None, *,
                   on_wait: Callable[[], Awaitable[Any]] | None = None, cleanup: bool = False) -> AsyncIterator[bool]:
        """Yield True when another owner used the screen since this owner last held it. Waiting honours Stop
        (signal) and calls on_wait first. Cleanup holds (input release) ignore Stop and a disabled lock."""
        if self.disabled and not cleanup:
            raise RunnerCoreError(self.disabled, code="desktop_cleanup_failed", status_code=503,
                                  hint="Release held keys and mouse buttons, check desktop input permissions, then restart the runner.")
        if self._owner is not owner:
            if self._lock.locked() and on_wait is not None:
                await await_active(on_wait(), signal)
            await self._acquire(signal)
            self._owner = owner
        self._depth += 1
        handed_over = self._last_owner not in (None, owner)
        self._last_owner = owner
        try:
            yield handed_over
        finally:
            self._depth -= 1
            if self._depth == 0:
                self._owner = None
                self._lock.release()


class RunScreen:
    """A run's handle on the shared screen lock: steps that use the screen hold it; others run alongside."""

    def __init__(self, lock: ScreenLock, signal: asyncio.Event | None = None, *,
                 on_wait: Callable[[], Awaitable[Any]] | None = None) -> None:
        self.lock = lock
        self.signal = signal
        self.on_wait = on_wait
        # Brings this run's window back to the front after another run used the screen (the lab browser).
        self.refocus: Callable[[], Awaitable[Any]] | None = None
        # True once this run has held the screen: its input may be part of the desktop's state.
        self.used = False
        # Worker globals bound only by screen-free steps, so later screen-free steps may use them without the lock.
        self.safe_names: set[str] = set()

    def step(self, code: str) -> AbstractAsyncContextManager[Any]:
        """Hold the screen around one model step if its code may use it. Waiting never counts toward the step deadline:
        the worker's timer starts once the step is sent."""
        tree = _parse(code)
        bound = _bound_names(tree) if tree is not None else set()
        if uses_screen(code, self.safe_names):
            self.safe_names -= bound
            return self.hold()
        self.safe_names |= bound
        return contextlib.nullcontext()

    @contextlib.asynccontextmanager
    async def hold(self) -> AsyncIterator[None]:
        async with self.lock.hold(self, self.signal, on_wait=self.on_wait) as handed_over:
            self.used = True
            if handed_over and self.refocus is not None:
                await self.refocus()
            yield

    def hold_for_cleanup(self) -> AbstractAsyncContextManager[bool]:
        """Input release: waits for another run's step to end so key-ups can't land mid-step; ignores Stop."""
        return self.lock.hold(self, cleanup=True)
