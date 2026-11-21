import asyncio
import json
import socket

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient

from app.config import Settings
from app.domain import COORDINATORS
from app.main import create_app

CREDS = {"login": "operator", "password": "test-password"}
ROW = {"id": "demo-001", "header": "Задержка начислений", "stateEnum": "Assigned",
       "state": "Назначен", "stateId": 0, "priorityId": 4, "deadline": "2030-01-01T00:00:00Z"}
NOTES = {"situation": "Зачисление задерживается.", "impact": "Масштаб уточняется.",
         "check": "Сверить время операции со временем зачисления."}


@pytest.fixture
def source(tmp_path):
    path = tmp_path / "records.json"
    path.write_text(json.dumps([ROW]), encoding="utf-8")
    return path


def settings(source, **overrides):
    values = dict(incidents_file=str(source), demo_login=CREDS["login"], demo_password=CREDS["password"],
                  demo_password_hash=None, llm_api_key=None, watch_polling=True)
    return Settings(_env_file=None, **(values | overrides))


def sign_in(client):
    response = client.post("/api/auth/login", json=CREDS)
    assert response.status_code == 200
    return response


def test_session_and_read_api(source):
    with TestClient(create_app(settings(source))) as client:
        for route in ("auth/me", "incidents", "incidents/events", "incidents/demo-001"):
            assert client.get("/api/" + route).status_code == 401
        assert client.post("/api/ai/chat", json={"messages": [{"role": "user", "content": "Что случилось?"}]}).status_code == 401
        assert client.post("/api/auth/login", json={**CREDS, "password": "bad"}).status_code == 401
        assert client.post("/api/auth/login", json=CREDS, headers={"Origin": "https://othersite.invalid"}).status_code == 403
        cookie = sign_in(client).headers["set-cookie"].lower()
        assert "httponly" in cookie and "samesite=lax" in cookie and "path=/api" in cookie
        assert client.get("/api/auth/me").json()["login"] == "operator"
        assert client.get("/api/incidents").json()["counts"]["critical"] == 1
        assert client.get("/api/incidents/demo-001").json()["header"] == ROW["header"]
        assert client.get("/api/incidents/missing").status_code == 404
        assert client.get("/api/health").json()["aiConfigured"] is False
        assert client.post("/api/ai/summary", json={"incidentId": "demo-001"}).json()["detail"] == "ИИ не настроен."
        assert client.post("/api/auth/logout", headers={"Origin": "https://othersite.invalid"}).status_code == 403
        assert client.post("/api/auth/logout").status_code == 204
        assert client.get("/api/incidents").status_code == 401


def test_missing_file_and_login_hash(source):
    from argon2 import PasswordHasher
    options = settings(source.with_suffix(".missing"), demo_password="unused",
                       demo_password_hash=PasswordHasher().hash(CREDS["password"]))
    with TestClient(create_app(options)) as client:
        sign_in(client)
        snap = client.get("/api/incidents").json()
        assert (snap["hasSnapshot"], snap["sourceStatus"], snap["demoMode"]) == (False, "error", False)
        assert client.get("/api/incidents/missing").status_code == 503


def test_summary_cache_chat_context_and_input_contract(source):
    calls = []
    def provider(req):
        body = json.loads(req.content)
        calls.append(body)
        assert req.headers["authorization"] == "Bearer test-key"
        content = json.dumps({"query": {"operation": "count", "scope": "critical"}} if "tools" in body else NOTES)
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    app = create_app(settings(source, llm_api_key="test-key"), provider_transport=httpx.MockTransport(provider))
    with TestClient(app) as client:
        sign_in(client)
        payload = {"incidentId": "demo-001"}
        response = client.post("/api/ai/summary", json=payload)
        assert response.status_code == 200 and response.json()["stale"] is False
        assert response.json()["incidentId"] == "demo-001"
        assert client.post("/api/ai/summary", json=payload).json() == response.json()
        assert len(calls) == 1
        messages = [{"role": "user", "content": "Сколько критических инцидентов?"}]
        chat = client.post("/api/ai/chat", json={"messages": messages})
        assert chat.status_code == 200
        assert chat.json()["answer"] == "Критические: 1."
        assert chat.json()["total"] == 1 and chat.json()["incidents"] == []
        assert calls[-1]["tools"][0]["function"]["name"] == "lookup_incidents"
        assert "test-key" not in json.dumps(calls[-1])
        for bad in ({"messages": messages, "context": {}}, {"messages": [{"role": "system", "content": "wrong"}]},
                    {"messages": [{"role": "user", "content": "?" * 2001}]}):
            assert client.post("/api/ai/chat", json=bad).status_code == 422

        source.write_text(json.dumps([{**ROW, "header": "Новый симптом"}]), encoding="utf-8")
        client.portal.call(app.state.store.reload)
        updated = client.post("/api/ai/summary", json=payload).json()
        assert updated["snapshotVersion"] > response.json()["snapshotVersion"]
        assert len(calls) == 3


@pytest.mark.parametrize(("upstream", "expected"), [(401, 502), (429, 429), (503, 502)])
def test_provider_error_is_sanitized(source, upstream, expected):
    mock = httpx.MockTransport(lambda _: httpx.Response(upstream, text="raw sensitive details"))
    with TestClient(create_app(settings(source, llm_api_key="test-key"), provider_transport=mock)) as client:
        sign_in(client)
        response = client.post("/api/ai/summary", json={"incidentId": "demo-001"})
        assert response.status_code == expected
        assert "sensitive" not in response.text and "test-key" not in response.text


def test_chat_accepts_plain_provider_and_includes_requested_description(source):
    source.write_text(json.dumps([{**ROW, "description": "Операция застревает при подтверждении."}]), encoding="utf-8")
    def provider(req):
        payload = json.loads(req.content)
        if "tools" in payload:
            args = json.dumps({"ids":["DEMO-001"],"analyze":True})
            return httpx.Response(200, json={"choices":[{"message":{"content":None,
                "tool_calls":[{"function":{"name":"lookup_incidents","arguments":args}}]}}]})
        context = json.loads(payload["messages"][1]["content"])
        assert context["selection"][0]["description"] == "Операция застревает при подтверждении."
        if "response_format" in payload:
            return httpx.Response(400, json={"error": {"message": "Unsupported response_format"}})
        return httpx.Response(200, json={"choices": [{"message": {"content": "Проверяется подтверждение.\n- demo-001"}}]})

    with TestClient(create_app(settings(source, llm_api_key="test-key"), provider_transport=httpx.MockTransport(provider))) as client:
        sign_in(client)
        answer = client.post("/api/ai/chat", json={"messages": [{"role": "user", "content": "Подробнее про DEMO-001"}]}).json()
        assert answer["answer"] == "Проверяется подтверждение." and answer["incidents"] == ["demo-001"]


def test_followup_reads_every_verified_row_in_order_after_source_change(source):
    records = [{**ROW, "id": f"INC-{n}", "header": f"Задержка расчёта {n}", "assignedGroupName": "Биллинг",
                "assignedEmployee": f"Дежурный {n}"} for n in range(12)]
    source.write_text(json.dumps(records), encoding="utf-8")
    ids = [row["id"] for row in reversed(records)]
    def provider(req):
        payload = json.loads(req.content)
        if "tools" in payload:
            assert "assignedEmployee" not in json.dumps(payload["messages"])
            return httpx.Response(200, json={"choices":[{"message":{"content":json.dumps({
                "query":{"scope":"previous","display":"owners","analyze":True}})}}]})
        context = json.loads(payload["messages"][1]["content"])
        assert context["matched"] == context["processed"] == 12
        assert [row["id"] for row in context["selection"]] == ids
        assert context["selection"][0]["assignedGroupName"] == "Новая команда"
        assert context["selection"][-1]["assignedEmployee"] == "Дежурный 0"
        return httpx.Response(200, json={"choices":[{"message":{"content":"Большинство задач ведёт биллинг."}}]})
    app = create_app(settings(source, llm_api_key="test-key"), provider_transport=httpx.MockTransport(provider))
    with TestClient(app) as client:
        sign_in(client)
        old = client.get("/api/incidents").json()
        records[-1]["assignedGroupName"] = "Новая команда"
        source.write_text(json.dumps(records), encoding="utf-8")
        client.portal.call(app.state.store.reload)
        response = client.post("/api/ai/chat", json={
            "messages":[{"role":"user","content":"Кто теперь ими занимается?"}],
            "previous":{"ids":ids, "epoch":old["epoch"], "snapshotVersion":old["snapshotVersion"]},
        })
        assert response.status_code == 200
        reply = response.json()
        assert reply["references"] == reply["incidents"] == ids
        assert reply["display"] == "owners" and "повторно" in reply["answer"]
        assert reply["snapshotVersion"] > old["snapshotVersion"]


def test_chat_can_converse_without_incident_file(source):
    replies = iter(["Привет! Чем помочь?", json.dumps({"query":{"scope":"critical","display":"list"}})])
    mock = httpx.MockTransport(lambda _: httpx.Response(200, json={"choices":[{"message":{"content":next(replies)}}]}))
    with TestClient(create_app(settings(source.with_suffix(".missing"), llm_api_key="test-key"), provider_transport=mock)) as client:
        sign_in(client)
        def ask(question):
            return client.post("/api/ai/chat", json={"messages":[{"role":"user","content":question}]}).json()
        assert ask("Привет")["answer"] == "Привет! Чем помочь?"
        unavailable = ask("Покажи критические")
        assert not unavailable["incidents"] and "недоступны" in unavailable["answer"]


@pytest.mark.parametrize(("owner", "stage", "candidate", "expected"), [
    (None, "Assigned", 1, "Расчёты"), ("?", "WorkInProgress", 1, "Расчёты"),
    (COORDINATORS, "Research", 1, "Расчёты"), (None, "Assigned", 20, "unknown"),
    (None, "Assigned", None, "unknown"), ("Уже назначена", "Assigned", 1, None),
    (None, "Resolved", 1, None), (COORDINATORS, "Closed", 1, None),
])
def test_summary_team_advice(source, owner, stage, candidate, expected):
    current = {**ROW, "assignedGroupName": owner, "stateEnum": stage, "service": "Зачисление"}
    example = {**ROW, "id": "old", "stateEnum": "Closed", "service": "Зачисление",
               "assignedGroupName": "Расчёты", "assignedEmployee": "Имя из другой записи"}
    unrelated = {**ROW, "id": "other", "header": "Пропала связь", "assignedGroupName": "Сети"}
    source.write_text(json.dumps([current, unrelated, example]), encoding="utf-8")

    def provider(request):
        payload = json.loads(request.content)
        context = json.loads(payload["messages"][1]["content"])
        assert payload["response_format"] == {"type": "json_object"}
        if expected is None:
            assert "routingExamples" not in context
        else:
            assert [item["id"] for item in context["routingExamples"]] == ["old"]
            assert "Имя из другой записи" not in json.dumps(context, ensure_ascii=False)
        reply = dict(NOTES, candidate=candidate, rationale="Совпадают сервис и симптом.")
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(reply)}}]})

    app = create_app(settings(source, llm_api_key="test-key"), provider_transport=httpx.MockTransport(provider))
    with TestClient(app) as client:
        sign_in(client)
        response = client.post("/api/ai/summary", json={"incidentId": ROW["id"]})
        assert response.status_code == 200
        result = response.json()["assessment"]
        assert result["check"] == NOTES["check"]
        if expected is None:
            assert result["routing"] is None
        elif expected == "unknown":
            assert result["routing"]["team"] is None and result["routing"]["exampleId"] is None
        else:
            assert result["routing"] == {"team": expected, "exampleId": "old", "reason": "Совпадают сервис и симптом."}
        assert client.get("/api/incidents/" + ROW["id"]).json()["assignedGroupName"] == owner


async def test_connected_clients_and_reconnect(source):
    # Test a streaming response over TCP. TestClient buffers until EOF.
    app = create_app(settings(source))
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))
        serving = asyncio.create_task(server.serve(sockets=[sock]))
        try:
            async with asyncio.timeout(15):
                while not server.started:
                    await asyncio.sleep(.02)
                async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", trust_env=False) as client:
                    assert (await client.post("/api/auth/login", json=CREDS)).status_code == 200
                    async def read_snapshot(lines):
                        async for line in lines:
                            if line.startswith("data:"):
                                return json.loads(line[5:])
                        raise AssertionError("Поток закрыт без снимка")

                    async with client.stream("GET", "/api/incidents/events") as a, client.stream("GET", "/api/incidents/events") as b:
                        for response in (a, b):
                            assert response.headers["content-type"].startswith("text/event-stream")
                        a_lines, b_lines = a.aiter_lines(), b.aiter_lines()
                        initial, second = await asyncio.gather(read_snapshot(a_lines), read_snapshot(b_lines))
                        assert initial["epoch"] == second["epoch"]
                        updated = source.with_suffix(".swap")
                        updated.write_text(json.dumps([{**ROW, "stateId": 7, "stateEnum": "Resolved", "priorityId": 2}]), encoding="utf-8")
                        updated.replace(source)
                        latest, another = await asyncio.gather(read_snapshot(a_lines), read_snapshot(b_lines))
                        assert latest["counts"]["history"] == 1
                        assert latest["snapshotVersion"] == another["snapshotVersion"] > initial["snapshotVersion"]
                        assert [e["kind"] for e in latest["notifications"]] == ["resolved"]
                    async with client.stream("GET", "/api/incidents/events") as reconnected:
                        lines = reconnected.aiter_lines()
                        current = await read_snapshot(lines)
                        assert current["notifications"] == latest["notifications"]
                        assert (await client.post("/api/auth/logout")).status_code == 204
                        # Existing streams stop after revocation even when the file remains unchanged.
                        async with asyncio.timeout(4):
                            assert all(not ln.startswith("data:") for ln in [ln async for ln in lines])
        finally:
            server.should_exit = True
            await serving


async def test_requested_summary_is_deduplicated_and_marks_changed_snapshot(source):
    started = asyncio.Event()
    finish = asyncio.Event()
    calls = []

    async def provider(request):
        calls.append(request)
        started.set()
        await finish.wait()
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(NOTES)}}]})

    options = settings(source, llm_api_key="test-key", llm_requests_per_minute=2, llm_max_concurrent=1)
    app = create_app(options, provider_transport=httpx.MockTransport(provider))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://testserver") as client:
            await client.post("/api/auth/login", json=CREDS)
            async def summary():
                return await client.post("/api/ai/summary", json={"incidentId": ROW["id"]})

            pending = [asyncio.create_task(summary()) for _ in range(2)]
            await asyncio.wait_for(started.wait(), timeout=2)
            chat = {"messages": [{"role": "user", "content": "Какой ближайший срок?"}]}
            assert (await client.post("/api/ai/chat", json=chat)).status_code == 429
            source.write_text(json.dumps([{**ROW, "assignedGroupName": "Дежурные"}]), encoding="utf-8")
            await app.state.store.reload()
            finish.set()
            first, other = await asyncio.gather(*pending)
            assert first.json() == other.json() and first.json()["stale"] is True
            assert len(calls) == 1
            fresh = (await summary()).json()
            assert fresh["stale"] is False
            assert fresh["snapshotVersion"] > first.json()["snapshotVersion"]
            assert len(calls) == 2
            assert (await client.post("/api/ai/chat", json=chat)).status_code == 429
