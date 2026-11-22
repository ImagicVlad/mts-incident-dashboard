import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from typing import Annotated
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, Security
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import APIKeyCookie
from fastapi.sse import EventSourceResponse, ServerSentEvent
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from .accounts import Profile
from .ai import AIAnswer, AIService, ChatInput, SummaryAnswer, SummaryInput, incident_by_id
from .config import Settings
from .demo_data import prepare_default_demo
from .domain import Incident, Snapshot, utc_string
from .security import COOKIE, Session, Sessions, check_origin
from .store import AssignmentConflict, Store, utc_now


class Login(BaseModel):
    model_config = ConfigDict(extra="forbid")
    login: str = Field(min_length=1, max_length=128)
    password: SecretStr = Field(min_length=1, max_length=256)


class Assignment(BaseModel):
    team: str = Field(min_length=1)
    employee: str | None
    expectedEmployee: str | None
    expectedTime: str | None


class Comment(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    id: UUID
    text: str = Field(min_length=1, max_length=2000)


class Health(BaseModel):
    status: str
    aiConfigured: bool
    displayTimezone: str


cookie_auth = APIKeyCookie(name=COOKIE, auto_error=False)


async def require_session(request: Request, token: Annotated[str | None, Security(cookie_auth)]) -> Session:
    session = request.app.state.sessions.find(token)
    if session is None:
        raise HTTPException(401, "Войдите в аккаунт.")
    return session


CurrentSession = Annotated[Session, Depends(require_session)]


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
        session = await sessions.authenticate(body.login, body.password.get_secret_value())
        sessions.revoke(request.cookies.get(COOKIE))
        response.set_cookie(COOKIE, session.token, max_age=settings.session_ttl_seconds, path="/api",
                            httponly=True, secure=settings.cookie_secure, samesite="lax")
        return session.profile

    @app.get("/api/auth/me", response_model=Profile, tags=["auth"])
    async def me(session: CurrentSession):
        return session.profile

    @app.post("/api/auth/logout", status_code=204, tags=["auth"])
    async def logout(session: CurrentSession, request: Request):
        request.app.state.sessions.revoke(session.token)
        response = Response(status_code=204)
        response.delete_cookie(COOKIE, path="/api", httponly=True, secure=settings.cookie_secure,
                               samesite="lax")
        return response

    @app.get("/api/incidents", response_model=Snapshot, tags=["incidents"])
    async def snapshot(request: Request, session: CurrentSession):
        return request.app.state.store.snapshot(session.profile.login)

    @app.get("/api/incidents/events", response_class=EventSourceResponse, tags=["incidents"],
             description="При подключении и после изменений приходит событие snapshot с полным снимком.")
    async def events(request: Request, session: CurrentSession) -> AsyncIterator[ServerSentEvent]:
        sessions = request.app.state.sessions
        updates = request.app.state.store.subscribe(session.profile.login)
        next_update = asyncio.create_task(anext(updates))
        try:
            while sessions.find(session.token):
                remaining = session.expires_at - time.monotonic()
                done, _ = await asyncio.wait({next_update}, timeout=max(0, min(2.0, remaining)))
                if not done:
                    continue
                snapshot = next_update.result()
                if not sessions.find(session.token):
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
    async def incident(incident_id: str, request: Request, session: CurrentSession):
        return incident_by_id(request.app.state.store.snapshot(), incident_id)

    @app.post("/api/incidents/{incident_id:path}/read", status_code=204, tags=["incidents"])
    async def read_incident(incident_id: str, request: Request, session: CurrentSession):
        try:
            request.app.state.store.mark_read(session.profile.login, incident_id)
        except KeyError:
            raise HTTPException(404, "Инцидент не найден.") from None
        return Response(status_code=204)

    @app.post("/api/incidents/{incident_id}/assignment", response_model=Snapshot | Incident, tags=["incidents"])
    async def assign(incident_id: str, body: Assignment, request: Request, session: CurrentSession,
                     includeSnapshot: bool = False):
        if session.profile.role != "coordinator":
            raise HTTPException(403, "Назначение команды доступно координатору.")
        try:
            store = request.app.state.store
            updated = await store.assign(incident_id, body.team, body.employee, body.expectedEmployee, body.expectedTime,
                                         session.profile.login)
            return store.snapshot(session.profile.login) if includeSnapshot else updated
        except AssignmentConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        except (OSError, ValueError) as exc:
            raise HTTPException(503, "Не удалось сохранить назначение. Попробуйте ещё раз.") from exc

    @app.get("/api/incidents/{incident_id}/activity", tags=["incidents"])
    async def activity(incident_id: str, request: Request, session: CurrentSession,
                       before: Annotated[int | None, Query(gt=0, le=2**63-1)] = None):
        store = request.app.state.store
        incident_by_id(store.snapshot(), incident_id)
        return store.activity.page(incident_id, before)

    @app.post("/api/incidents/{incident_id}/comments", status_code=204, tags=["incidents"])
    async def comment(incident_id: str, body: Comment, request: Request, session: CurrentSession):
        store = request.app.state.store
        incident_by_id(store.snapshot(), incident_id)
        store.activity.comment(incident_id, body.id.hex, utc_string(utc_now()), session.profile.login, body.text)
        return Response(status_code=204)

    @app.post("/api/ai/summary", response_model=SummaryAnswer, tags=["ai"])
    async def summary(body: SummaryInput, request: Request, session: CurrentSession):
        return await request.app.state.ai.summary(body.incidentId)

    @app.post("/api/ai/chat", response_model=AIAnswer, tags=["ai"])
    async def chat(body: ChatInput, request: Request, session: CurrentSession):
        return await request.app.state.ai.chat(body)

    return app


app = create_app()
