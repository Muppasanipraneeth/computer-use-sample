import re
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.desktop import web_instruments
from app.desktop.web_instruments import VIEWPORT, BackgroundBrowser
from app.instruments import instrument_lines

ENDPOINT = "ws://127.0.0.1:9222/devtools/browser/one"


@pytest.fixture
def port_file(tmp_path, monkeypatch):
    path = tmp_path / "DevToolsActivePort"
    path.write_text("9222\n/devtools/browser/one\n")
    monkeypatch.setenv("JARVIS_BROWSER_CDP_FILE", str(path))
    return path


@pytest.fixture
def chromium(monkeypatch, port_file):
    """A Playwright stand-in whose Target.createTarget adds a fresh page to the shared context, named by target id."""
    monkeypatch.delenv("JARVIS_BROWSER_GATEWAY", raising=False)
    monkeypatch.delenv("JARVIS_BROWSER_UNAVAILABLE", raising=False)
    monkeypatch.delenv("JARVIS_BROWSER_BLOCKED_FILE", raising=False)
    chromium = MagicMock()
    browser = chromium.connect_over_cdp.return_value
    context = MagicMock()
    context.pages = []
    browser.contexts = [context]
    browser.is_connected.return_value = True
    targets: dict[int, str] = {}
    chromium.opened = []

    def create_target(method, params=None):
        assert method == "Target.createTarget" and params == {"url": "about:blank", "background": True}
        page = MagicMock()
        page.is_closed.return_value = False
        target = f"T{len(targets)}"
        targets[id(page)] = target
        context.pages.append(page)
        chromium.opened.append(page)
        return {"targetId": target}

    browser.new_browser_cdp_session.return_value.send.side_effect = create_target
    context.new_cdp_session.side_effect = lambda page: MagicMock(
        send=MagicMock(return_value={"targetInfo": {"targetId": targets.get(id(page), "other")}})
    )
    chromium.targets = targets
    playwright = SimpleNamespace(chromium=chromium, stop=MagicMock())
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: SimpleNamespace(start=lambda: playwright))
    return chromium


def test_local_browser_shares_the_runners_profile_context_and_closes_only_its_pages(chromium):
    browser = BackgroundBrowser()
    page, reader = browser.page, browser.reader
    chromium.connect_over_cdp.assert_called_once_with(ENDPOINT, timeout=5_000)
    chromium.launch_persistent_context.assert_not_called()
    connected = chromium.connect_over_cdp.return_value
    context = connected.contexts[0]
    # Background tabs, never new_page(): the browser may be the user's sign-in window.
    context.new_page.assert_not_called()
    assert [page, reader] == chromium.opened
    page.set_viewport_size.assert_called_with(VIEWPORT)
    browser.close()
    page.close.assert_called_once()
    reader.close.assert_called_once()
    connected.close.assert_called_once()  # a disconnect for a CDP connection
    context.close.assert_not_called()  # the persistent context belongs to the shared host


def test_another_workers_new_page_is_not_taken(chromium):
    context = chromium.connect_over_cdp.return_value.contexts[0]
    session = chromium.connect_over_cdp.return_value.new_browser_cdp_session.return_value
    create_target = session.send.side_effect

    def with_a_neighbour(method, params=None):
        context.pages.append(MagicMock())  # another run's worker opened a page at the same moment
        return create_target(method, params)

    session.send.side_effect = with_a_neighbour
    assert BackgroundBrowser().page is chromium.opened[0]


def test_reconnecting_follows_the_browser_that_holds_the_profile_now(chromium, port_file, monkeypatch):
    monkeypatch.setattr(web_instruments, "CONNECT_WAIT_S", 2)
    browser = BackgroundBrowser()
    _ = browser.page
    connected = chromium.connect_over_cdp.return_value
    # The runner handed the profile to the sign-in window. Sync Playwright still reports the old connection as up
    # until its next call; the port file already names the new browser.
    port_file.write_text("9333\n/devtools/browser/two\n")
    attempts = []

    def connect(endpoint, timeout):
        attempts.append(endpoint)
        if len(attempts) == 1:
            raise RuntimeError("connect ECONNREFUSED")  # the window is still starting
        return connected

    chromium.connect_over_cdp.side_effect = connect
    page = browser.page
    assert attempts == ["ws://127.0.0.1:9333/devtools/browser/two"] * 2
    assert page is chromium.opened[-1] and len(chromium.opened) == 2


def test_no_running_browser_fails_after_the_wait(chromium, port_file, monkeypatch):
    monkeypatch.setattr(web_instruments, "CONNECT_WAIT_S", 0.3)
    port_file.unlink()
    with pytest.raises(RuntimeError, match="not reachable"):
        _ = BackgroundBrowser().page
    chromium.connect_over_cdp.assert_not_called()


def test_a_blocked_runner_browser_reports_why_and_a_later_call_connects(chromium, port_file, tmp_path, monkeypatch):
    monkeypatch.setattr(web_instruments, "BLOCKED_WAIT_S", 0.2)
    blocked = tmp_path / "JarvisBrowserBlocked"
    blocked.write_text("Quit the Jarvis sign-in browser with ⌘Q (closing its window isn't enough), then try again.\n")
    monkeypatch.setenv("JARVIS_BROWSER_BLOCKED_FILE", str(blocked))
    port_file.unlink()
    browser = BackgroundBrowser()
    with pytest.raises(RuntimeError, match="⌘Q"):
        _ = browser.page
    chromium.connect_over_cdp.assert_not_called()
    # The runner's host opened a browser once the user quit the sign-in one.
    blocked.unlink()
    port_file.write_text("9222\n/devtools/browser/one\n")
    assert browser.page is chromium.opened[0]
    chromium.connect_over_cdp.assert_called_once_with(ENDPOINT, timeout=5_000)


def test_local_browser_reports_why_the_runner_has_none(chromium, monkeypatch):
    monkeypatch.delenv("JARVIS_BROWSER_CDP_FILE")
    monkeypatch.setenv("JARVIS_BROWSER_UNAVAILABLE", "The background browser is already open on another profile.")
    with pytest.raises(RuntimeError, match="another profile"):
        _ = BackgroundBrowser().page
    chromium.connect_over_cdp.assert_not_called()


def test_local_browser_needs_the_endpoint(chromium, monkeypatch):
    monkeypatch.delenv("JARVIS_BROWSER_CDP_FILE")
    with pytest.raises(RuntimeError, match="JARVIS_BROWSER_CDP_FILE"):
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
    assert browser.goto("https://example.com") is chromium.opened[0].title.return_value
    page = chromium.opened[0]
    page.goto.assert_called_once()
    assert page.goto.call_args.args[0] == "https://example.com"
