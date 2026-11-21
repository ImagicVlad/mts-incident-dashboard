import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response, Security
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import APIKeyCookie
from fastapi.sse import EventSourceResponse, ServerSentEvent
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from .ai import AIAnswer, AIService, ChatInput, SummaryAnswer, SummaryInput, incident_by_id
from .config import Settings
from .demo_data import prepare_default_demo
from .domain import Incident, Snapshot
from .security import COOKIE, Sessions, check_origin
from .store import Store


class Login(BaseModel):
    model_config = ConfigDict(extra="forbid")
    login: str = Field(min_length=1, max_length=128)
    password: SecretStr = Field(min_length=1, max_length=256)


class Profile(BaseModel):
    login: str
    displayName: str


class Health(BaseModel):
    status: str
    aiConfigured: bool
    displayTimezone: str


cookie_auth = APIKeyCookie(name=COOKIE, auto_error=False)


async def require_session(request: Request, token: Annotated[str | None, Security(cookie_auth)]) -> str:
    if not request.app.state.sessions.active(token):
        raise HTTPException(401, "Войдите в аккаунт координатора.")
    return token


CurrentSession = Annotated[str, Depends(require_session)]


def create_app(settings: Settings | None = None, *, provider_transport=None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        source_path = settings.source_path if settings.incidents_file else prepare_default_demo()
        store = Store(source_path, demo=not bool(settings.incidents_file),
                      polling=settings.watch_polling, itsm_url_template=settings.itsm_url_template)
        app.state.store = store
        app.state.sessions = Sessions(settings)
        async with httpx.AsyncClient(timeout=settings.llm_timeout_seconds,
                                     transport=provider_transport) as client:
            app.state.ai = AIService(settings, store, client)
            await store.start()
            try:
                yield
            finally:
                await app.state.ai.close()
                await store.stop()

    app = FastAPI(title="Пульт координатора инцидентов", version="1.0.0", lifespan=lifespan,
                  dependencies=[Depends(check_origin)])
    app.state.settings = settings

    @app.exception_handler(RequestValidationError)
    async def invalid_input(request, exception):
        return JSONResponse({"detail": "Проверьте поля запроса и длину текста."}, status_code=422)

    @app.middleware("http")
    async def prevent_cached_sessions(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/api/health", response_model=Health, tags=["service"])
    async def health():
        return Health(status="ok", aiConfigured=settings.ai_configured,
                      displayTimezone=settings.display_timezone)

    @app.post("/api/auth/login", response_model=Profile, tags=["auth"])
    async def login(body: Login, request: Request, response: Response):
        sessions = request.app.state.sessions
        token = await sessions.authenticate(body.login, body.password.get_secret_value())
        sessions.expires.pop(request.cookies.get(COOKIE), None)
        response.set_cookie(COOKIE, token, max_age=settings.session_ttl_seconds, path="/api",
                            httponly=True, secure=settings.cookie_secure, samesite="lax")
        return Profile(login=settings.demo_login, displayName="Координатор смены")

    @app.get("/api/auth/me", response_model=Profile, tags=["auth"])
    async def me(token: CurrentSession):
        return Profile(login=settings.demo_login, displayName="Координатор смены")

    @app.post("/api/auth/logout", status_code=204, tags=["auth"])
    async def logout(token: CurrentSession, request: Request):
        request.app.state.sessions.expires.pop(token, None)
        response = Response(status_code=204)
        response.delete_cookie(COOKIE, path="/api", httponly=True, secure=settings.cookie_secure,
                               samesite="lax")
        return response

    @app.get("/api/incidents", response_model=Snapshot, tags=["incidents"])
    async def snapshot(request: Request, token: CurrentSession):
        return request.app.state.store.snapshot()

    @app.get("/api/incidents/events", response_class=EventSourceResponse, tags=["incidents"],
             description="При подключении и после изменений приходит событие snapshot с полным снимком.")
    async def events(request: Request, token: CurrentSession) -> AsyncIterator[ServerSentEvent]:
        sessions = request.app.state.sessions
        updates = request.app.state.store.subscribe()
        next_update = asyncio.create_task(anext(updates))
        try:
            while sessions.active(token):
                remaining = sessions.expires[token] - time.monotonic()
                done, _ = await asyncio.wait({next_update}, timeout=max(0, min(2.0, remaining)))
                if not done:
                    continue
                snapshot = next_update.result()
                if not sessions.active(token):
                    break
                yield ServerSentEvent(event="snapshot", data=snapshot, retry=2000,
                                      id=f"{snapshot['epoch']}/{snapshot['snapshotVersion']}")
                next_update = asyncio.create_task(anext(updates))
        finally:
            next_update.cancel()
            with suppress(asyncio.CancelledError, StopAsyncIteration):
                await next_update
            await updates.aclose()

    @app.get("/api/incidents/{incident_id}", response_model=Incident, tags=["incidents"])
    async def incident(incident_id: str, request: Request, token: CurrentSession):
        return incident_by_id(request.app.state.store.snapshot(), incident_id)

    @app.post("/api/ai/summary", response_model=SummaryAnswer, tags=["ai"])
    async def summary(body: SummaryInput, request: Request, token: CurrentSession):
        return await request.app.state.ai.summary(body.incidentId)

    @app.post("/api/ai/chat", response_model=AIAnswer, tags=["ai"])
    async def chat(body: ChatInput, request: Request, token: CurrentSession):
        return await request.app.state.ai.chat(body)

    return app


app = create_app()
