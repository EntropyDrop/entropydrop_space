from fastapi import Request
from slowapi import Limiter
import hashlib
import ipaddress
from config import settings


class HeaderSafeLimiter(Limiter):
    """Let middleware add headers when an endpoint returns a plain JSON value."""

    def _check_request_limit(self, request, endpoint_func, in_middleware=True):
        if not in_middleware:
            super()._check_request_limit(request, endpoint_func, True)
        return super()._check_request_limit(request, endpoint_func, in_middleware)

    def _inject_headers(self, response, current_limit):
        if response is None:
            return response
        try:
            return super()._inject_headers(response, current_limit)
        except Exception:
            self.logger.warning("Could not add rate-limit response headers", exc_info=True)
            return response


def _trusted_proxy_networks():
    networks = []
    for raw_cidr in settings.TRUSTED_PROXY_CIDRS.split(","):
        cidr = raw_cidr.strip()
        if not cidr:
            continue
        try:
            networks.append(ipaddress.ip_network(cidr, strict=False))
        except ValueError:
            continue
    return networks


def _client_host(request: Request) -> str:
    if request.client:
        return request.client.host
    return "127.0.0.1"


def _is_trusted_proxy(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(ip in network for network in _trusted_proxy_networks())


def _valid_ip(value: str | None) -> str | None:
    if not value:
        return None
    candidate = value.strip()
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        return None
    return str(address)


def _forwarded_client_ip(value: str | None) -> str | None:
    """Return the first untrusted hop in a validated X-Forwarded-For chain."""
    if not value:
        return None

    addresses = []
    for raw_address in value.split(","):
        address = _valid_ip(raw_address)
        if address is None:
            # Do not partially trust a malformed chain. A trusted proxy may still
            # provide a separately validated X-Real-IP fallback.
            return None
        addresses.append(address)

    # Proxies append addresses on the right. Peeling trusted hops from that end
    # prevents a client-supplied prefix from becoming the rate-limit identity.
    for address in reversed(addresses):
        if not _is_trusted_proxy(address):
            return address
    return addresses[0] if addresses else None


def get_real_remote_address(request: Request) -> str:
    """
    Get the client IP address, only trusting proxy headers from configured proxies.
    """
    client_host = _client_host(request)
    if not _is_trusted_proxy(client_host):
        return client_host

    forwarded_ip = _forwarded_client_ip(request.headers.get("X-Forwarded-For"))
    if forwarded_ip:
        return forwarded_ip

    real_ip = _valid_ip(request.headers.get("X-Real-IP"))
    if real_ip:
        return real_ip

    return client_host


def get_authenticated_or_remote_address(request: Request) -> str:
    """Use an authenticated credential bucket when available, otherwise the IP."""
    principal = getattr(request.state, "rate_limit_principal", None)
    if principal:
        return str(principal)

    # The standalone Space service intentionally does not possess the account
    # JWT signing key. A digest gives each login/API credential a stable bucket
    # without retaining a secret in Redis; the application-wide IP limit still
    # bounds attempts made with rotating invalid credentials.
    authorization = request.headers.get("Authorization", "")
    scheme, _, credential = authorization.partition(" ")
    if scheme.lower() == "bearer" and credential:
        digest = hashlib.sha256(credential.encode("utf-8")).hexdigest()[:32]
        return f"credential:{digest}"

    return get_real_remote_address(request)


async def ensure_rate_limit_headers(request: Request, call_next):
    """Add headers for decorated routes that return dicts or Pydantic models."""
    response = await call_next(request)
    current_limit = getattr(request.state, "view_rate_limit", None)
    if current_limit is not None and "X-RateLimit-Limit" not in response.headers:
        return request.app.state.limiter._inject_headers(response, current_limit)
    return response


limiter = HeaderSafeLimiter(
    key_func=get_real_remote_address,
    default_limits=["60/minute", "1000/hour", "4000/day"],
    application_limits=["1200/minute", "50000/hour"],
    headers_enabled=True,
    storage_uri=settings.REDIS_URL,
    in_memory_fallback_enabled=True,
    enabled=settings.RATELIMIT_ENABLED,
    key_style="endpoint",
)
