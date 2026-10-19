import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values, load_dotenv

from .model_selection import FAST_MODEL, QUICK_MODEL, STRONG_MODEL

APP_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = APP_ROOT.parent
_defaults = json.loads((REPO_ROOT / "contracts" / "defaults.json").read_text(encoding="utf-8"))
DEFAULT_MODEL: str = _defaults["model"]
DEFAULT_MODEL_DISPLAY_NAME: str = _defaults["modelDisplayName"]


def env_file() -> Path:
    """The .env with saved keys: JARVIS_ENV_FILE (the installed app's userData copy), else the repo's."""
    configured = os.environ.get("JARVIS_ENV_FILE", "").strip()
    return Path(configured).expanduser() if configured else REPO_ROOT / ".env"


def load_environment() -> None:
    load_dotenv(env_file(), override=False)


def composio_api_key() -> str:
    """The shell value wins as for every key; otherwise .env is re-read per run, so a key saved in Settings works without
    restarting the runner."""
    value = os.environ.get("COMPOSIO_API_KEY", "").strip()
    if value:
        return value
    return str(dotenv_values(env_file()).get("COMPOSIO_API_KEY") or "").strip()


def desktop_user_data() -> Path:
    """The desktop app's Electron userData folder (app name "Jarvis"), where it keeps the profile and browser logins."""
    home = Path.home()
    if sys.platform == "darwin":
        base = home / "Library" / "Application Support"
    elif sys.platform == "win32":
        base = Path(os.environ.get("APPDATA") or home / "AppData" / "Roaming")
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config")
    return base / "Jarvis"


def log_dir() -> Path:
    """Where the runner writes runner.log: JARVIS_LOG_DIR, else the platform's per-user log folder."""
    if configured := os.environ.get("JARVIS_LOG_DIR", "").strip():
        return Path(configured).expanduser()
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Logs" / "Jarvis"
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or home / "AppData" / "Local") / "Jarvis" / "logs"
    return Path(os.environ.get("XDG_STATE_HOME") or home / ".local" / "state") / "jarvis" / "logs"


def labs_root() -> Path:
    """The labs folder (catalog.json and templates): JARVIS_LABS_ROOT, set by the installed app to its bundled copy,
    else the repo's."""
    configured = os.environ.get("JARVIS_LABS_ROOT", "").strip()
    return Path(configured).expanduser() if configured else REPO_ROOT / "labs"


@dataclass(frozen=True)
class Settings:
    data_root: Path = APP_ROOT / "data"
    default_model: str = DEFAULT_MODEL
    host: str = "127.0.0.1"
    port: int = 4041
    # How many runs may work at once; screen steps from different runs still take turns (app/screen.py).
    max_concurrent_runs: int = 3
    # Finished runs kept on disk: the newest keep_runs, none older than keep_days (storage.prune_storage).
    keep_runs: int = 50
    keep_days: float = 30
    # Auto's model per tier (model_routing): the task picks the starting tier, escalation moves one tier up.
    quick_model: str = QUICK_MODEL
    fast_model: str = FAST_MODEL
    strong_model: str = STRONG_MODEL

    def tier_models(self) -> dict[str, str]:
        return {"quick": self.quick_model, "fast": self.fast_model, "strong": self.strong_model}

    @classmethod
    def from_environment(cls) -> "Settings":
        max_concurrent_runs = int(os.environ.get("JARVIS_MAX_CONCURRENT_RUNS", "3"))
        if max_concurrent_runs < 1:
            raise ValueError("JARVIS_MAX_CONCURRENT_RUNS must be at least 1.")
        return cls(data_root=Path(os.environ.get("JARVIS_DATA_ROOT", APP_ROOT / "data")).resolve(),
                   default_model=os.environ.get("JARVIS_DEFAULT_MODEL", DEFAULT_MODEL),
                   host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "4041")),
                   max_concurrent_runs=max_concurrent_runs,
                   keep_runs=max(0, int(os.environ.get("JARVIS_KEEP_RUNS", "50"))),
                   keep_days=max(0.0, float(os.environ.get("JARVIS_KEEP_DAYS", "30"))),
                   quick_model=os.environ.get("JARVIS_QUICK_MODEL", "").strip() or QUICK_MODEL,
                   fast_model=os.environ.get("JARVIS_FAST_MODEL", "").strip() or FAST_MODEL,
                   strong_model=os.environ.get("JARVIS_STRONG_MODEL", "").strip() or STRONG_MODEL)

    def capabilities(self) -> dict:
        return {"backendId": "python", "codeTool": "exec_py", "browserModes": ["headful"],
                "defaults": {"browserMode": "headful", "model": self.default_model,
                             "maxResponseTurns": 24}}
