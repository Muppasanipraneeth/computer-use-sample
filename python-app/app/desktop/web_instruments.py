"""Background web instruments for model code: read(url) and web (a Playwright browser). Neither touches the user's
screen, mouse or keyboard. With Cloudflare Browser Run configured they use the cloud (only the gateway URL is known
here, never the token); otherwise the browser the runner keeps on Jarvis's browser profile (app/local_browser_host.py):
its shared headless Chromium, or the Settings sign-in window while that is open, so sites the user signed in to stay
signed in. Other runs share that browser: this worker opens and closes only its own pages."""

from __future__ import annotations

import atexit
import contextlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

READ_LIMIT = 20_000
# Background work must stay well inside the runner's 60 s step deadline.
PAGE_TIMEOUT_MS = 20_000
VIEWPORT = {"width": 1280, "height": 900}
# The runner switches browsers when the user opens or quits the sign-in window; reconnecting waits that long for it.
CONNECT_WAIT_S = 15
# While the runner reports why it has no browser, how long a connect waits for it to retry before raising that reason.
BLOCKED_WAIT_S = 2


def _gateway() -> str | None:
    value = os.environ.get("JARVIS_BROWSER_GATEWAY", "").strip()
    return value.rstrip("/") or None


def _endpoint_file() -> str:
    value = os.environ.get("JARVIS_BROWSER_CDP_FILE", "").strip()
    if not value:
        # The runner explains why this run got no share of its browser (it is open on another profile, ...).
        reason = os.environ.get("JARVIS_BROWSER_UNAVAILABLE", "").strip()
        raise RuntimeError(reason or "JARVIS_BROWSER_CDP_FILE is not set; the Jarvis runner passes it to this worker.")
    return value


def _blocked_reason() -> str | None:
    """Why the runner has no browser on the profile right now (a sign-in browser without a DevTools port holds it, ...).
    The runner keeps trying and removes the file once a browser is up, so a later call can succeed."""
    path = os.environ.get("JARVIS_BROWSER_BLOCKED_FILE", "").strip()
    if not path:
        return None
    try:
        return Path(path).read_text().strip() or None
    except OSError:
        return None


def _read_endpoint(path: str) -> str | None:
    """The CDP endpoint in Chromium's DevToolsActivePort file, written by whichever browser holds the profile now. The
    browser id in it also tells a new browser from the one this worker is connected to."""
    try:
        lines = Path(path).read_text().splitlines()
        port = int(lines[0])
    except (OSError, ValueError, IndexError):
        return None
    if 0 < port < 65536 and len(lines) >= 2 and lines[1].startswith("/devtools/browser/"):
        return f"ws://127.0.0.1:{port}{lines[1]}"
    return None


def _connect_local(chromium: Any) -> tuple[Any, str]:
    path = _endpoint_file()
    started = time.monotonic()
    failure: Exception | None = None
    while True:
        endpoint = _read_endpoint(path)
        if endpoint is not None:
            try:
                return chromium.connect_over_cdp(endpoint, timeout=5_000), endpoint
            except Exception as error:  # noqa: BLE001 - a browser that just quit; the runner is opening the next one
                failure = error
        waited = time.monotonic() - started
        reason = _blocked_reason()
        if reason is not None and waited >= BLOCKED_WAIT_S:
            raise RuntimeError(reason)
        if waited >= CONNECT_WAIT_S:
            raise RuntimeError(f"Jarvis's background browser is not reachable: {failure or 'it has not started'}")
        time.sleep(0.25)


def _quick_markdown(gateway: str, url: str, kitesurf: bool) -> str:
    endpoint = f"{gateway}/markdown" + ("?browser=kitesurf" if kitesurf else "")
    request = urllib.request.Request(
        endpoint, data=json.dumps({"url": url}).encode(), headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read()[:500].decode("utf-8", "replace")
        raise RuntimeError(f"Browser Run markdown failed with HTTP {error.code}: {detail}") from None
    if not isinstance(body, dict) or body.get("success") is not True or not isinstance(body.get("result"), str):
        raise RuntimeError(f"Browser Run markdown returned no result: {str(body)[:500]}")
    return body["result"]


# Page text as lightly marked-up lines: headings, links and list items keep enough structure to scan.
_PAGE_TEXT = """() => {
  const out = [];
  const walk = (node) => {
    for (const child of node.children) {
      const tag = child.tagName;
      if (["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "NAV", "FOOTER", "IFRAME"].includes(tag)) continue;
      const style = getComputedStyle(child);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (/^H[1-6]$/.test(tag)) { out.push("#".repeat(+tag[1]) + " " + child.innerText.trim()); continue; }
      if (tag === "A" && child.href && child.innerText.trim()) { out.push(`[${child.innerText.trim()}](${child.href})`); continue; }
      if (tag === "LI" || tag === "P" || tag === "TD" || tag === "TIME") {
        const text = child.innerText.trim();
        if (text) { out.push((tag === "LI" ? "- " : "") + text); continue; }
      }
      walk(child);
    }
  };
  walk(document.body);
  return out.join("\\n");
}"""


def _clean(text: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def read(url: str, fast: bool = True) -> str:
    """Return the page at url as markdown-like text (at most 20000 characters), without touching the screen."""
    gateway = _gateway()
    if gateway is not None:
        if fast:
            try:
                return _quick_markdown(gateway, url, True)[:READ_LIMIT]
            except RuntimeError:
                pass  # Kitesurf cannot render every page; retry once on default Chromium.
        return _quick_markdown(gateway, url, False)[:READ_LIMIT]
    page = web.reader
    page.goto(url, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
    with contextlib.suppress(Exception):  # Pages that keep loading still have readable text.
        page.wait_for_load_state("networkidle", timeout=3_000)
    return _clean(f"# {page.title()}\n{page.evaluate(_PAGE_TEXT)}")[:READ_LIMIT]


def _target_id(context: Any, page: Any) -> str | None:
    try:
        session = context.new_cdp_session(page)
    except Exception:  # noqa: BLE001 - another worker's page that closed meanwhile
        return None
    try:
        return session.send("Target.getTargetInfo")["targetInfo"]["targetId"]
    finally:
        with contextlib.suppress(Exception):
            session.detach()


class BackgroundBrowser:
    """Lazily connected Chromium with one page for web and one for read(): Cloudflare's cloud browser when configured,
    otherwise the runner's browser on Jarvis's profile. Either way it never moves the user's mouse; after the runner
    switches browsers (the sign-in window opened or quit) the next use reconnects with fresh pages."""

    def __init__(self) -> None:
        self._playwright: Any = None
        self._browser: Any = None
        self._endpoint: str | None = None  # the local browser connected to, as DevToolsActivePort named it
        self._context: Any = None
        self._context_closed = False
        self._page: Any = None
        self._reader: Any = None
        self._last: Any = None  # the page used most recently, for the app's Live view

    def _alive(self) -> bool:
        if self._context is None or self._context_closed:
            return False
        # Sync Playwright only notices a lost connection during a call, so a browser switch would first surface as an
        # error in the model's code. The port file names the browser holding the profile now.
        if self._endpoint is not None and _read_endpoint(_endpoint_file()) != self._endpoint:
            return False
        return self._browser is not None and self._browser.is_connected()

    def _connect(self) -> Any:
        if not self._alive():
            from playwright.sync_api import sync_playwright

            gateway = _gateway()
            if gateway is None:
                _endpoint_file()  # explains a missing browser before Playwright starts
            if self._playwright is None:
                self._playwright = sync_playwright().start()
            chromium = self._playwright.chromium
            if gateway is not None:
                self._browser = chromium.connect_over_cdp(gateway.replace("http://", "ws://", 1) + "/devtools/browser?keep_alive=600000")
            else:
                self._browser, self._endpoint = _connect_local(chromium)
            # The local host's default context is its persistent profile (the user's logins); it is shared with other
            # runs, so this worker never closes it.
            self._context = self._browser.contexts[0] if self._browser.contexts else self._browser.new_context(viewport=VIEWPORT)
            self._context_closed = False
            context = self._context
            context.on("close", lambda _closed: self._forget(context))
            self._page = self._reader = self._last = None
        return self._context

    def _forget(self, context: Any) -> None:
        if context is self._context:
            self._context_closed = True

    def _new_page(self) -> Any:
        context = self._connect()
        page = context.new_page() if _gateway() is not None else self._background_tab(context)
        page.set_viewport_size(VIEWPORT)
        page.set_default_timeout(PAGE_TIMEOUT_MS)
        return page

    def _background_tab(self, context: Any) -> Any:
        """A tab that doesn't take focus: while the runner shares the user's sign-in window, a foreground tab would
        replace the page they are typing a password into. Other workers open pages in the same context, so the new
        page is matched by target id."""
        before = set(context.pages)
        session = self._browser.new_browser_cdp_session()
        try:
            target = session.send("Target.createTarget", {"url": "about:blank", "background": True})["targetId"]
        finally:
            session.detach()
        deadline = time.monotonic() + PAGE_TIMEOUT_MS / 1000
        while True:
            for page in context.pages:
                if page not in before and _target_id(context, page) == target:
                    return page
            if time.monotonic() >= deadline:
                raise RuntimeError("The background browser did not open a page.")
            with contextlib.suppress(Exception):  # Playwright's TimeoutError: look at the pages again
                context.wait_for_event("page", timeout=250)

    @property
    def page(self) -> Any:
        if self._page is None or self._page.is_closed() or not self._alive():
            self._page = self._new_page()
        self._last = self._page
        return self._page

    @property
    def reader(self) -> Any:
        if self._reader is None or self._reader.is_closed() or not self._alive():
            self._reader = self._new_page()
        self._last = self._reader
        return self._reader

    def goto(self, url: str) -> str:
        """Open url in the background browser's page and return its title."""
        page = self.page
        page.goto(url, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
        return page.title()

    def screenshot(self) -> bytes:
        """PNG of the background browser's page, for display(web.screenshot())."""
        return self.page.screenshot(type="png")

    def preview(self) -> bytes | None:
        """A screenshot of the page used last, for the app's Live view; None before any page was opened."""
        if self._last is None or self._last.is_closed():
            return None
        try:
            return self._last.screenshot(type="png", timeout=5_000)
        except Exception:  # noqa: BLE001 - The preview is cosmetic; a page mid-navigation just skips it.
            return None

    def close(self) -> None:
        # Close only this worker's pages, then disconnect: Browser.close() on a CDP connection drops the connection
        # and leaves the browser (and its shared context) running for other runs.
        pages = (self._page, self._reader)
        browser, playwright = self._browser, self._playwright
        self._page = self._reader = self._last = self._browser = self._context = self._playwright = None
        for owner, method in ((pages[0], "close"), (pages[1], "close"), (browser, "close"), (playwright, "stop")):
            if owner is not None:
                with contextlib.suppress(Exception):  # Best-effort shutdown; the worker is exiting anyway.
                    getattr(owner, method)()


web = BackgroundBrowser()
atexit.register(web.close)
