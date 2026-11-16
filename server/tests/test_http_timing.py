import asyncio

from fastapi import FastAPI
from fastapi.testclient import TestClient

import http_timing
from http_middleware import configure_http


def test_timing_preserves_existing_metrics_and_streams_without_buffering(monkeypatch):
    clock = iter((10.0, 10.0125))
    monkeypatch.setattr(http_timing, "perf_counter", lambda: next(clock))
    sent = []
    messages = [
        {"type": "http.response.start", "status": 200,
         "headers": [(b"server-timing", b"db;dur=3")]},
        {"type": "http.response.body", "body": b"first", "more_body": True},
        {"type": "http.response.body", "body": b"second", "more_body": False},
    ]

    async def app(scope, receive, send):
        for index, message in enumerate(messages):
            await send(message)
            assert len(sent) == index + 1

    async def send(message):
        sent.append(message)

    asyncio.run(http_timing.ServerTimingMiddleware(app)({"type": "http"}, None, send))
    assert sent[0]["headers"] == [(b"server-timing", b"db;dur=3, space_app;dur=12.50")]
    assert sent[1:] == messages[1:]


def test_timing_bypasses_non_http_scopes(monkeypatch):
    def no_clock():
        raise AssertionError("Non-HTTP scopes must not be timed")

    monkeypatch.setattr(http_timing, "perf_counter", no_clock)
    called = []

    async def app(scope, receive, send):
        called.append(scope["type"])

    middleware = http_timing.ServerTimingMiddleware(app)
    for kind in ("websocket", "lifespan"):
        asyncio.run(middleware({"type": kind}, None, None))
    assert called == ["websocket", "lifespan"]


def test_timing_covers_success_errors_and_early_rejection(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "https://client.example.test")
    app = FastAPI()
    configure_http(app)

    @app.get("/space/health")
    async def health():
        return {"status": "ok"}

    @app.get("/space/failure")
    async def failure():
        raise RuntimeError("test failure")

    with TestClient(app, raise_server_exceptions=False) as client:
        responses = [
            client.get("/space/health", headers={"Origin": "https://client.example.test"}),
            client.get("/space/missing"),
            client.get("/space/failure"),
            client.post("/space/oversized", content=b"x", headers={"Content-Length": "600000"}),
        ]
    assert [response.status_code for response in responses] == [200, 404, 500, 413]
    for response in responses:
        timing = response.headers["server-timing"]
        assert timing.startswith("space_app;dur=")
        assert float(timing.split("=")[1]) >= 0
    assert "Server-Timing" in responses[0].headers["access-control-expose-headers"]
