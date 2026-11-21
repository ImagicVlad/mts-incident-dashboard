import asyncio
import secrets
import time
from collections import deque

from argon2 import PasswordHasher, extract_parameters
from argon2.exceptions import VerificationError
from fastapi import HTTPException, Request

from .config import Settings

COOKIE = "coordinator_session"


class Sessions:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.hasher = PasswordHasher()
        self.password_hash = (
            settings.demo_password_hash.get_secret_value() if settings.demo_password_hash
            else self.hasher.hash(settings.demo_password.get_secret_value())
        )
        extract_parameters(self.password_hash)
        self.expires: dict[str, float] = {}
        self.attempts: deque[float] = deque()
        self.verifiers = asyncio.Semaphore(2)

    def active(self, token: str | None) -> bool:
        if not token:
            return False
        if self.expires.get(token, 0) <= time.monotonic():
            self.expires.pop(token, None)
            return False
        return True

    async def authenticate(self, login: str, password: str) -> str:
        now = time.monotonic()
        while self.attempts and now - self.attempts[0] >= 60:
            self.attempts.popleft()
        if len(self.attempts) >= 30 or self.verifiers.locked():
            raise HTTPException(429, "Слишком много попыток входа. Попробуйте позже.")
        self.attempts.append(now)
        async with self.verifiers:
            try:
                valid = await asyncio.to_thread(self.hasher.verify, self.password_hash, password)
            except VerificationError:
                valid = False
        if not valid or login != self.settings.demo_login:
            raise HTTPException(401, "Неверный логин или пароль.")
        for key in list(self.expires):
            self.active(key)
        if len(self.expires) >= 512:
            self.expires.pop(next(iter(self.expires)))
        token = secrets.token_urlsafe(32)
        self.expires[token] = time.monotonic() + self.settings.session_ttl_seconds
        return token


async def check_origin(request: Request):
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return
    origin = request.headers.get("origin")
    if not origin and request.headers.get("sec-fetch-site") != "cross-site":
        return  # CLI clients do not send Origin.
    allowed = {value.strip().rstrip("/") for value in request.app.state.settings.allowed_origins.split(",")}
    if not origin or origin.rstrip("/") not in (allowed | {str(request.base_url).rstrip("/")}):
        raise HTTPException(403, "Источник запроса не разрешён.")
