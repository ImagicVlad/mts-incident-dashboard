"""Verify the built frontend, cookie auth and actual SSE through the public web origin."""
import argparse
import getpass
import http.cookiejar
import json
import os
import urllib.request


def check(origin: str):
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def get(path):
        return client.open(origin + path, timeout=10)
    with get("/dashboard") as response:
        assert 'id="root"' in response.read().decode()
    with get("/api/health") as response:
        assert json.load(response)["status"] == "ok"
    credentials = {"login": os.getenv("SMOKE_LOGIN") or input("Логин пульта: ").strip(),
                   "password": os.getenv("SMOKE_PASSWORD") or getpass.getpass("Пароль: ")}
    req = urllib.request.Request(origin + "/api/auth/login", data=json.dumps(credentials).encode(),
                                 headers={"Content-Type":"application/json","Origin":origin})
    with client.open(req, timeout=10) as response:
        account = json.load(response)
        assert account["login"] == credentials["login"]
        assert account["role"] in {"coordinator", "executor"}
    with get("/api/incidents") as response:
        snapshot = json.load(response)
    assert snapshot["hasSnapshot"] and snapshot["sourceStatus"] == "ok"
    with get("/api/incidents/events") as response:
        assert response.headers.get_content_type() == "text/event-stream"
        for line in response:
            if line.startswith(b"data:"):
                event = json.loads(line[5:])
                assert event["epoch"] == snapshot["epoch"] and event["incidents"] == snapshot["incidents"]
                break
        else:
            raise AssertionError("SSE ended without its initial snapshot")
    with client.open(urllib.request.Request(origin + "/api/auth/logout", method="POST",
                                            headers={"Origin":origin}), timeout=10) as response:
        assert response.status == 204
    print(f"SPA, health, login, snapshot, SSE OK | {len(snapshot['incidents'])} incidents | {snapshot['counts']}")


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("origin", nargs="?", default="http://127.0.0.1:8080")
    check(cli.parse_args().origin.rstrip("/"))
