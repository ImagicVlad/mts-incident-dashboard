import asyncio
import secrets
import time
from collections import deque
from dataclasses import dataclass

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import HTTPException, Request

from .accounts import Accounts, Profile
from .config import Settings

COOKIE = "coordinator_session"


@dataclass(frozen=True)
class Session:
    token: str
    profile: Profile
    expires_at: float


class Sessions:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.hasher = PasswordHasher()
        self.accounts = Accounts(settings.accounts_path)
        # Unknown logins follow the same Argon2 verification path.
        self.dummy_hash = self.hasher.hash(secrets.token_urlsafe(32))
        self._sessions: dict[str, Session] = {}
        self.attempts: deque[float] = deque()
        self.verifiers = asyncio.Semaphore(2)

    def find(self, token: str | None) -> Session | None:
        session = self._sessions.get(token) if token else None
        if session and session.expires_at <= time.monotonic():
            self.revoke(session.token)
            return None
        return session

    def revoke(self, token: str | None) -> None:
        if token:
            self._sessions.pop(token, None)

    def _verify(self, login: str, password: str) -> Profile | None:
        credentials = self.accounts.credentials(login)
        password_hash = credentials[1] if credentials else self.dummy_hash
        try:
            self.hasher.verify(password_hash, password)
        except (VerificationError, InvalidHashError):
            return None
        return credentials[0] if credentials else None

    async def authenticate(self, login: str, password: str) -> Session:
        now = time.monotonic()
        while self.attempts and now - self.attempts[0] >= 60:
            self.attempts.popleft()
        if len(self.attempts) >= 30 or self.verifiers.locked():
            raise HTTPException(429, "Слишком много попыток входа. Попробуйте позже.")
        self.attempts.append(now)
        async with self.verifiers:
            profile = await asyncio.to_thread(self._verify, login, password)
        if profile is None:
            raise HTTPException(401, "Неверный логин или пароль.")
        for key in list(self._sessions):
            self.find(key)
        if len(self._sessions) >= 512:
            self.revoke(next(iter(self._sessions)))
        token = secrets.token_urlsafe(32)
        session = Session(token, profile, time.monotonic() + self.settings.session_ttl_seconds)
        self._sessions[token] = session
        return session


async def check_origin(request: Request):
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return
    origin = request.headers.get("origin")
    if not origin and request.headers.get("sec-fetch-site") != "cross-site":
        return  # CLI clients do not send Origin.
    allowed = {value.strip().rstrip("/") for value in request.app.state.settings.allowed_origins.split(",")}
    if not origin or origin.rstrip("/") not in (allowed | {str(request.base_url).rstrip("/")}):
        raise HTTPException(403, "Источник запроса не разрешён.")
