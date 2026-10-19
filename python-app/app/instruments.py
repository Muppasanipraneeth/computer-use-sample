"""The one source of instrument text shown to the model."""


def instrument_lines(*, web: bool, cloud: bool = False, apps: bool = False) -> list[str]:
    if not web:
        return ["Only pyautogui (this computer) is available."]
    where = "Cloudflare's cloud" if cloud else "a headless Chromium on this computer"
    # Only the local browser keeps Jarvis's profile; the cloud browser starts signed out every time.
    logins = [] if cloud else [
        (
            "The background browser keeps the logins the user saved in Settings → Connections → Sign in to websites. "
            "If a site asks you to log in, do not try credentials: stop and tell the user to sign in to that site there, then ask again."
        ),
    ]
    # Present only when the runner started the Composio gateway for this run (a key is set in Settings).
    connected_apps = [
        (
            "apps reaches the accounts the user connected in Jarvis Settings (Gmail, Google Calendar, Slack, X, GitHub, Notion, …) "
            "through their APIs, also in the background: apps.connected() lists connected app slugs; "
            "apps.search('send an email', app='gmail') returns matching tools with their inputs; "
            "apps.run('GMAIL_SEND_EMAIL', {...}) runs one as the user and returns its result."
        ),
        (
            "Prefer apps for a connected app (send or read email, read or post in Slack, post to X, calendar events). "
            "If the app is not connected or no tool fits, do it on the website with web instead."
        ),
        (
            "Before sending a message or email, or posting anything publicly, show the user the exact text and recipient and "
            "ask them to confirm, unless they explicitly asked you to send or post it."
        ),
    ] if apps else []
    return [
        "The user may be using this computer while you work. Work in the background whenever you can, so their mouse, keyboard and windows are left alone.",
        f"Background instruments available to your Python code, both running in {where} and invisible on this screen:",
        "read(url) returns a page as markdown quickly. Use it to look things up and answer questions (news, weather, prices, documentation).",
        (
            "web is a Playwright browser: web.goto(url) returns the page title; web.page is a Playwright sync Page "
            "(web.page.click(selector), web.page.fill(selector, text), web.page.get_by_role(...)); display(web.screenshot()) to see it. "
            "Use it for websites you must click or type in."
        ),
        *logins,
        *connected_apps,
        "subprocess and AppleScript (osascript) also work without the mouse, e.g. telling Spotify to play.",
        (
            "pyautogui controls the user's real mouse, keyboard and screen. Use it only when a task needs a desktop app's "
            "interface that nothing above can drive, and keep that part short. Never use it to browse the web."
        ),
        "Keep each step short: page loads and network calls time out at 20 s, and a step that runs past 60 s is stopped.",
        "pyautogui screenshots never show the background browser.",
    ]
