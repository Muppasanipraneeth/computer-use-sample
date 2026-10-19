"""Background web instruments for model code: read(url) and web (a Playwright browser). Neither touches the user's
screen, mouse or keyboard. With Cloudflare Browser Run configured they use the cloud (only the gateway URL is known
here, never the token); otherwise the runner's shared headless Chromium on this computer (app/local_browser_host.py),
which keeps Jarvis's browser profile, so sites the user signed in to from Settings stay signed in. Other runs share
that browser: this worker opens and closes only its own pages."""

from __future__ import annotations

import atexit
import contextlib
import json
import os
import re
import urllib.error
import urllib.request
from typing import Any

READ_LIMIT = 20_000
# Background work must stay well inside the runner's 60 s step deadline.
PAGE_TIMEOUT_MS = 20_000
VIEWPORT = {"width": 1280, "height": 900}


def _gateway() -> str | None:
    value = os.environ.get("JARVIS_BROWSER_GATEWAY", "").strip()
    return value.rstrip("/") or None


def _local_endpoint() -> str:
    value = os.environ.get("JARVIS_BROWSER_CDP", "").strip()
    if not value:
        # The runner explains why its shared browser is unavailable (the sign-in window holds the profile, ...).
        reason = os.environ.get("JARVIS_BROWSER_UNAVAILABLE", "").strip()
        raise RuntimeError(reason or "JARVIS_BROWSER_CDP is not set; the Jarvis runner passes it to this worker.")
    return value


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


class BackgroundBrowser:
    """Lazily connected Chromium with one page for web and one for read(): Cloudflare's cloud browser when configured,
    otherwise the runner's shared headless Chromium. Either way it is invisible and never moves the user's mouse."""

    def __init__(self) -> None:
        self._playwright: Any = None
        self._browser: Any = None
        self._context: Any = None
        self._context_closed = False
        self._page: Any = None
        self._reader: Any = None
        self._last: Any = None  # the page used most recently, for the app's Live view

    def _alive(self) -> bool:
        if self._context is None or self._context_closed:
            return False
        return self._browser is not None and self._browser.is_connected()

    def _connect(self) -> Any:
        if not self._alive():
            from playwright.sync_api import sync_playwright

            gateway = _gateway()
            if gateway is not None:
                endpoint = gateway.replace("http://", "ws://", 1) + "/devtools/browser?keep_alive=600000"
            else:
                endpoint = _local_endpoint()
            if self._playwright is None:
                self._playwright = sync_playwright().start()
            self._browser = self._playwright.chromium.connect_over_cdp(endpoint)
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
        page = self._connect().new_page()
        page.set_viewport_size(VIEWPORT)
        page.set_default_timeout(PAGE_TIMEOUT_MS)
        return page

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
