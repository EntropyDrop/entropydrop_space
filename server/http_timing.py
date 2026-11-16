"""HTTP response-header timing without buffering response streams."""
from time import perf_counter

from starlette.datastructures import MutableHeaders


class ServerTimingMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        started_at = perf_counter()

        async def send_with_timing(message):
            if message["type"] == "http.response.start":
                elapsed_ms = (perf_counter() - started_at) * 1000
                headers = MutableHeaders(scope=message)
                timing = f"space_app;dur={elapsed_ms:.2f}"
                existing = headers.get("server-timing")
                headers["server-timing"] = f"{existing}, {timing}" if existing else timing
            await send(message)

        await self.app(scope, receive, send_with_timing)
