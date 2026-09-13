import pytest
import redis
from unittest.mock import MagicMock
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from fastapi import Depends
from fastapi.testclient import TestClient
class FakeRedis(MagicMock):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._store = {}
    
    def get(self, name):
        return self._store.get(name)
        
    def set(self, name, value, ex=None, px=None, nx=False, xx=False, keepttl=False):
        # Redis stores keys/values as bytes or string. Let's store as bytes or convert to match Redis behavior.
        self._store[name] = str(value).encode('utf-8') if not isinstance(value, bytes) else value
        return True
        
    def delete(self, *names):
        for name in names:
            self._store.pop(name, None)
        return len(names)

    def incr(self, name, amount=1):
        val = self._store.get(name, b"0")
        try:
            val_int = int(val)
        except ValueError:
            val_int = 0
        new_val = val_int + amount
        self._store[name] = str(new_val).encode('utf-8')
        return new_val

    def expire(self, name, time):
        return True

_fake_redis_instance = FakeRedis()
redis.Redis.from_url = classmethod(lambda cls, *args, **kwargs: _fake_redis_instance)

from space.main import app
from space.database import Base, get_db
from space import models # Ensure all models are loaded into Base.metadata

from sqlalchemy.pool import StaticPool

# Use SQLite in-memory database for testing
SQLALCHEMY_DATABASE_URL = "sqlite:///:memory:"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, 
    connect_args={"check_same_thread": False},
    poolclass=StaticPool
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

@pytest.fixture(scope="function")
def db():
    # Create tables before each test
    Base.metadata.create_all(bind=engine)
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()
        # Drop tables after each test
        Base.metadata.drop_all(bind=engine)

@pytest.fixture(scope="function")
def client(db):
    def override_get_db():
        try:
            yield db
        finally:
            pass
    
    # Override dependency
    app.dependency_overrides[get_db] = override_get_db
    
    # The account service is mocked by dependency overrides, never local account tables.
    from space.auth import get_current_user
    from routers.space_entities import _entity_creator, EntityCreator
    def creator(user=Depends(get_current_user)):
        return EntityCreator(user=user, credential="test-account-proof")
    app.dependency_overrides[_entity_creator] = creator

    # Disable rate limiting for testing
    if hasattr(app.state, "limiter"):
        app.state.limiter.enabled = False

    # Create client
    c = TestClient(app)
    yield c
    
    # Re-enable rate limiting after test if needed
    if hasattr(app.state, "limiter"):
        app.state.limiter.enabled = True

    # Clear overrides
    app.dependency_overrides.clear()


def mock_account_key(user, scopes):
    """Supply an identity already verified by the separate account service."""
    user.api_key_count = 1
    from space.auth import get_current_user
    from routers.space_entities import _entity_creator, EntityCreator
    from space.integrations.account_contract import SPACE_API_KEY_SCOPES
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[_entity_creator] = lambda: EntityCreator(
        user=user, api_key_scopes=frozenset(SPACE_API_KEY_SCOPES), credential="test-account-proof")
    return {"id": "test-account-key", "api_key": "test-account-proof"}
