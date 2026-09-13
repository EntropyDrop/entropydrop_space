"""Guard the extraction boundary and the account-service wire contract."""
import ast
from pathlib import Path
import pytest
from pydantic import ValidationError
from fastapi import HTTPException
from config import Settings, settings
from space.main import app
from space.integrations import account_client

ROOT = Path(__file__).resolve().parents[1]

def test_server_cannot_enable_integrated_account_mode():
    with pytest.raises(ValidationError):
        Settings(SPACE_STANDALONE=False)
    assert Settings(SPACE_STANDALONE="true").SPACE_STANDALONE

def test_server_excludes_account_owned_routes_and_imports():
    paths = {getattr(route, "path", "") for route in app.routes}
    assert not any(path.startswith(("/skin", "/internal/space", "/space/api/v2/api-keys")) for path in paths)
    forbidden = {"auth", "models", "database", "credit_balance", "s3_utils", "routers.space_accounts", "routers.space_billing"}
    for path in ROOT.rglob("*.py"):
        if any(part in path.parts for part in (".venv", "venv", "tests", "__pycache__", "migration-reference")):
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            modules = [node.module] if isinstance(node, ast.ImportFrom) else [alias.name for alias in node.names] if isinstance(node, ast.Import) else []
            assert not forbidden.intersection(modules), str(path)

def test_account_rpc_uses_internal_contract_and_service_token(monkeypatch):
    monkeypatch.setattr(settings, "SPACE_ACCOUNT_API_URL", "http://127.0.0.1:18082")
    monkeypatch.setattr(settings, "SPACE_ACCOUNT_SERVICE_TOKEN", "test-service-token")
    calls = []
    class Response:
        status_code = 200
        is_success = True
        def json(self):
            return {"state": "reserved"}
    def post(url, **kwargs):
        calls.append((url, kwargs))
        return Response()
    monkeypatch.setattr(account_client.httpx, "post", post)
    assert account_client.call("reservations", {"id": "test"}) == {"state": "reserved"}
    url, options = calls[0]
    assert url == "http://127.0.0.1:18082/internal/space/reservations"
    assert options["headers"]["X-Space-Service-Token"] == "test-service-token"
    assert options["json"] == {"id": "test"}
    assert options["follow_redirects"] is False and options["trust_env"] is False

def test_account_rpc_rejects_missing_service_configuration(monkeypatch):
    monkeypatch.setattr(settings, "SPACE_ACCOUNT_SERVICE_TOKEN", "")
    with pytest.raises(HTTPException) as error:
        account_client.call("identity", {})
    assert error.value.status_code == 503
