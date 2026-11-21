"""Start one isolated backend for Playwright, independent of local production settings."""
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
import uvicorn
from app.config import Settings
from app.demo_data import RUNTIME, demo_records, write_records
from app.main import create_app

if __name__ == "__main__":
    source = Path(os.environ["E2E_SOURCE"]).resolve()
    if source.parent != RUNTIME.resolve() or not source.name.startswith("e2e-"):
        raise ValueError("E2E source must be a dedicated file in data/runtime")
    write_records(source, demo_records(datetime.now(UTC)))
    settings = Settings(_env_file=None, incidents_file=str(source), watch_polling=True,
                        demo_login="coordinator.demo", demo_password="mts-demo-local",
                        llm_api_key=None, cookie_secure=False,
                        allowed_origins="http://127.0.0.1:5186")
    try:
        uvicorn.run(create_app(settings), host="127.0.0.1", port=8016)
    finally:
        source.unlink(missing_ok=True)
