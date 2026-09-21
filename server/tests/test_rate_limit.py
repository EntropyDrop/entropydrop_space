from starlette.requests import Request

import rate_limit


def make_request(client_host: str, headers: dict[str, str] | None = None) -> Request:
    raw_headers = [
        (key.lower().encode("latin-1"), value.encode("latin-1"))
        for key, value in (headers or {}).items()
    ]
    return Request({
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": raw_headers,
        "client": (client_host, 12345),
        "server": ("testserver", 80),
        "scheme": "http",
    })


def test_rate_limit_ignores_forwarded_headers_from_untrusted_clients(monkeypatch):
    monkeypatch.setattr(rate_limit.settings, "TRUSTED_PROXY_CIDRS", "10.0.0.0/8")
    request = make_request(
        "198.51.100.10",
        {
            "X-Real-IP": "203.0.113.20",
            "X-Forwarded-For": "203.0.113.30",
        },
    )

    assert rate_limit.get_real_remote_address(request) == "198.51.100.10"


def test_rate_limit_peels_trusted_proxy_chain(monkeypatch):
    monkeypatch.setattr(rate_limit.settings, "TRUSTED_PROXY_CIDRS", "10.0.0.0/8")
    request = make_request(
        "10.1.2.3",
        {
            "X-Real-IP": "10.2.3.4",
            "X-Forwarded-For": "203.0.113.30, 10.9.8.7",
        },
    )

    assert rate_limit.get_real_remote_address(request) == "203.0.113.30"


def test_rate_limit_discards_spoofed_forwarded_prefix(monkeypatch):
    monkeypatch.setattr(rate_limit.settings, "TRUSTED_PROXY_CIDRS", "10.0.0.0/8")
    request = make_request(
        "10.1.2.3",
        {"X-Forwarded-For": "192.0.2.99, 203.0.113.30"},
    )

    assert rate_limit.get_real_remote_address(request) == "203.0.113.30"


def test_rate_limit_falls_back_to_real_ip_for_malformed_forwarded_chain(monkeypatch):
    monkeypatch.setattr(rate_limit.settings, "TRUSTED_PROXY_CIDRS", "10.0.0.0/8")
    request = make_request(
        "10.1.2.3",
        {
            "X-Real-IP": "203.0.113.20",
            "X-Forwarded-For": "spoofed, 203.0.113.30",
        },
    )

    assert rate_limit.get_real_remote_address(request) == "203.0.113.20"


def test_authenticated_rate_limit_uses_stable_credential_digest():
    first = make_request(
        "198.51.100.10",
        {"Authorization": "Bearer login-token-123"},
    )
    second = make_request(
        "203.0.113.20",
        {"Authorization": "Bearer login-token-123"},
    )

    first_key = rate_limit.get_authenticated_or_remote_address(first)
    assert first_key.startswith("credential:")
    assert rate_limit.get_authenticated_or_remote_address(second) == first_key


def test_limiter_uses_endpoint_scopes_and_response_headers():
    assert rate_limit.limiter._key_style == "endpoint"
    assert rate_limit.limiter._headers_enabled is True
    assert rate_limit.limiter._application_limits
