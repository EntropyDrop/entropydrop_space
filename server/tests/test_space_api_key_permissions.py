import pytest
from fastapi.security import HTTPAuthorizationCredentials
from routers import space_entities
from space.integrations.account_contract import SPACE_API_KEY_SCOPES
from tests.test_space_entities import _user

@pytest.mark.parametrize('cached_scopes', [[], ['space:entity:create'], None])
def test_standalone_identity_normalizes_legacy_key_permissions(db, monkeypatch, cached_scopes):
    owner = _user(db, 'standalone-key-owner')
    
    monkeypatch.setattr(space_entities.auth, 'resolve_identity',
        lambda *_args, **_kwargs: (owner, cached_scopes), raising=False)
    creator = space_entities._entity_creator(
        HTTPAuthorizationCredentials(scheme='Bearer', credentials='verified-by-cloud'), db)
    assert creator.user is owner
    assert creator.api_key_scopes == (None if cached_scopes is None else frozenset(SPACE_API_KEY_SCOPES))
