import re
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.desktop.web_instruments import VIEWPORT, BackgroundBrowser
from app.instruments import instrument_lines

ENDPOINT = "http://127.0.0.1:9222"


@pytest.fixture
def chromium(monkeypatch):
    monkeypatch.delenv("JARVIS_BROWSER_GATEWAY", raising=False)
    monkeypatch.delenv("JARVIS_BROWSER_UNAVAILABLE", raising=False)
    monkeypatch.setenv("JARVIS_BROWSER_CDP", ENDPOINT)
    chromium = MagicMock()
    browser = chromium.connect_over_cdp.return_value
    browser.contexts = [MagicMock()]
    browser.is_connected.return_value = True
    playwright = SimpleNamespace(chromium=chromium, stop=MagicMock())
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: SimpleNamespace(start=lambda: playwright))
    return chromium


def test_local_browser_shares_the_runners_profile_context_and_closes_only_its_pages(chromium):
    browser = BackgroundBrowser()
    page, reader = browser.page, browser.reader
    chromium.connect_over_cdp.assert_called_once_with(ENDPOINT)
    chromium.launch_persistent_context.assert_not_called()
    connected = chromium.connect_over_cdp.return_value
    context = connected.contexts[0]
    assert context.new_page.call_count == 2 and page is reader is context.new_page.return_value
    page.set_viewport_size.assert_called_with(VIEWPORT)
    browser.close()
    assert page.close.call_count == 2  # web's page and read()'s page (one mock here)
    connected.close.assert_called_once()  # a disconnect for a CDP connection
    context.close.assert_not_called()  # the persistent context belongs to the shared host


def test_local_browser_reports_why_the_runner_has_none(chromium, monkeypatch):
    monkeypatch.delenv("JARVIS_BROWSER_CDP")
    monkeypatch.setenv("JARVIS_BROWSER_UNAVAILABLE", "Close the Jarvis sign-in browser window, then try again.")
    with pytest.raises(RuntimeError, match="Close the Jarvis sign-in browser window"):
        _ = BackgroundBrowser().page
    chromium.connect_over_cdp.assert_not_called()


def test_local_browser_needs_the_endpoint(chromium, monkeypatch):
    monkeypatch.delenv("JARVIS_BROWSER_CDP")
    with pytest.raises(RuntimeError, match="JARVIS_BROWSER_CDP"):
        _ = BackgroundBrowser().page


def test_closed_context_reconnects(chromium):
    browser = BackgroundBrowser()
    _ = browser.page
    context = chromium.connect_over_cdp.return_value.contexts[0]
    on_close = next(call.args[1] for call in context.on.call_args_list if call.args[0] == "close")
    on_close(context)
    _ = browser.page
    assert chromium.connect_over_cdp.call_count == 2


def test_cloud_mode_still_connects_over_cdp(chromium, monkeypatch):
    monkeypatch.setenv("JARVIS_BROWSER_GATEWAY", "http://127.0.0.1:9/gw")
    _ = BackgroundBrowser().page
    chromium.connect_over_cdp.assert_called_once_with("ws://127.0.0.1:9/gw/devtools/browser?keep_alive=600000")


@pytest.mark.parametrize("cloud", [False, True])
def test_every_web_call_the_model_is_told_about_exists(cloud):
    # The instructions once promised web.goto and web.screenshot after they had been dropped from the class.
    text = "\n".join(instrument_lines(web=True, cloud=cloud))
    named = set(re.findall(r"\bweb\.(\w+)", text))
    assert {"goto", "screenshot", "page"} <= named
    assert all(hasattr(BackgroundBrowser, name) for name in named), named


def test_goto_opens_the_page_and_returns_its_title(chromium):
    browser = BackgroundBrowser()
    page = chromium.connect_over_cdp.return_value.contexts[0].new_page.return_value
    page.title.return_value = "Example Domain"
    page.is_closed.return_value = False
    assert browser.goto("https://example.com") == "Example Domain"
    page.goto.assert_called_once()
    assert page.goto.call_args.args[0] == "https://example.com"
