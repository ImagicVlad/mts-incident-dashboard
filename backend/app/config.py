from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env", env_file_encoding="utf-8",
        env_ignore_empty=True, extra="ignore",
    )

    incidents_file: str = ""
    display_timezone: str = "Europe/Moscow"
    itsm_url_template: str = ""
    watch_polling: bool = False
    demo_login: str = Field(default="coordinator.demo", min_length=1)
    demo_password: SecretStr = SecretStr("mts-demo-local")
    demo_password_hash: SecretStr | None = None
    session_ttl_seconds: int = Field(default=28800, ge=1, le=604800)
    cookie_secure: bool = False
    allowed_origins: str = ",".join(
        f"http://{host}:{port}" for host in ("127.0.0.1", "localhost")
        for port in (5173, 5174, 8080)
    )

    llm_api_key: SecretStr | None = None
    llm_base_url: str = "https://api.openai.com/v1"
    llm_model: str = "gpt-5.4-mini"
    llm_timeout_seconds: float = Field(30, gt=0, le=120)
    llm_requests_per_minute: int = Field(12, ge=1, le=600)
    llm_max_concurrent: int = Field(2, ge=1, le=16)
    llm_summary_ttl_seconds: int = Field(180, ge=1, le=3600)

    @property
    def source_path(self) -> Path:
        if self.incidents_file:
            return (BACKEND_DIR / self.incidents_file).resolve()
        return PROJECT_DIR / "data" / "demo" / "character_problems.json"

    @property
    def ai_configured(self) -> bool:
        return bool(self.llm_api_key and self.llm_api_key.get_secret_value().strip()
                    and self.llm_model.strip() and self.llm_base_url.strip())
