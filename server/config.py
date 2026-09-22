"""Space-only settings. This process cannot open the account database or sign login JWTs."""
import os
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    ENVIRONMENT: str = "development"
    STRICT_CONFIG_VALIDATION: bool = False
    REDIS_URL: str = "redis://localhost:6379/0"
    DATABASE_URL: str = ""
    DB_POOL_SIZE: int = 3
    DB_MAX_OVERFLOW: int = 2
    DB_POOL_TIMEOUT: int = 30
    DB_POOL_RECYCLE: int = 1800
    SPACE_DEFAULT_WORLD_ID: str = "00000000-0000-4000-8000-000000000001"
    SPACE_COPPER_METROPOLIS_WORLD_ID: str = "00000000-0000-4000-8000-000000000003"
    SPACE_COPPER_METROPOLIS_WORLD_SEED: int = 20260922
    SPACE_AETHER_ARCHIPELAGO_WORLD_ID: str = "00000000-0000-4000-8000-000000000004"
    SPACE_AETHER_ARCHIPELAGO_WORLD_SEED: int = 42
    SPACE_STANDALONE: bool = True
    SPACE_ACCOUNT_API_URL: str = ""
    SPACE_OUTBOUND_PROXY_URL: str = ""
    SPACE_ACCOUNT_SERVICE_TOKEN: str = ""
    SPACE_IDENTITY_CACHE_SECONDS: int = 30
    SPACE_PUBLIC_API_URL: str = ""
    SPACE_OBJECT_DIR: str = "/var/lib/space/objects"
    SPACE_JOIN_TICKET_SECRET: str = ""
    SPACE_HOSTING_ENABLED: bool = False
    SPACE_WORLD_SEED: int = 20260827
    SPACE_WS_URL: str = "/space/ws/v2"
    SPACE_WS_ALLOWED_ORIGINS: str = ""
    SPACE_REALTIME_INPUT_HZ: int = 20
    SPACE_REALTIME_SNAPSHOT_HZ: int = 10
    SPACE_REALTIME_PERSIST_SECONDS: int = 5
    SPACE_REALTIME_AOI_RADIUS_CHUNKS: int = 16
    SPACE_REALTIME_REDIS_FANOUT_ENABLED: bool = True
    SPACE_TERRAIN_BURST_LIMIT: int = 5_000
    SPACE_TERRAIN_HOURLY_LIMIT: int = 80_000
    SPACE_TERRAIN_DAILY_LIMIT: int = 100_000
    SPACE_TERRAIN_WORLD_SECOND_LIMIT: int = 5_000
    SPACE_TERRAIN_MAX_CHUNKS_PER_BATCH: int = 16
    SPACE_TERRAIN_MAX_ZONES_PER_BATCH: int = 4
    SPACE_TERRAIN_EDIT_RADIUS_CHUNKS: int = 8
    SPACE_TERRAIN_POSITION_GRACE_SECONDS: int = 30
    SPACE_TERRAIN_MAX_EVENT_BYTES: int = 16 * 1024 * 1024
    SPACE_TERRAIN_MAX_RESPONSE_BYTES: int = 16 * 1024 * 1024
    SPACE_ENTITY_MAX_TOTAL_BYTES_PER_OWNER: int = 128 * 1024 * 1024
    SPACE_ENTITY_MAX_RUNNING_PER_OWNER: int = 8
    SPACE_ENTITY_MAX_RUNNING_PER_WORLD: int = 64
    SPACE_ENTITY_MAX_RUNNING_PER_CHUNK: int = 16
    SPACE_ENTITY_CHECKPOINT_MINUTE_BYTES: int = 16 * 1024 * 1024
    SPACE_ENTITY_CHECKPOINT_DAILY_BYTES: int = 512 * 1024 * 1024
    SPACE_MARKET_MAX_RESOURCES_PER_OWNER: int = 100
    SPACE_MARKET_MAX_TOTAL_BYTES_PER_OWNER: int = 256 * 1024 * 1024
    SPACE_MARKET_DAILY_UPLOAD_BYTES: int = 64 * 1024 * 1024
    SPACE_TERRAIN_BATCH_RECEIPT_RETENTION_DAYS: int = 30
    TRUSTED_PROXY_CIDRS: str = "127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
    RATELIMIT_ENABLED: bool = True
    CORS_ORIGINS: str = ""
    @field_validator("SPACE_STANDALONE")
    @classmethod
    def require_standalone(cls, value):
        if not value:
            raise ValueError("Space server only supports standalone mode")
        return value

    model_config = SettingsConfigDict(env_file=os.getenv("ENV_FILE", ".env"), env_file_encoding="utf-8", extra="ignore")

settings = Settings()

def validate_runtime_settings():
    strict = settings.STRICT_CONFIG_VALIDATION or settings.ENVIRONMENT.lower() in {"prod", "production"}
    if not strict:
        return
    errors = []
    if not settings.DATABASE_URL.startswith(("postgresql://", "postgresql+")):
        errors.append("DATABASE_URL must use PostgreSQL")
    if not settings.REDIS_URL:
        errors.append("REDIS_URL is required")
    for field in ("SPACE_ACCOUNT_SERVICE_TOKEN", "SPACE_JOIN_TICKET_SECRET"):
        if len(getattr(settings, field)) < 32:
            errors.append(f"{field} must contain at least 32 characters")
    for field in ("SPACE_ACCOUNT_API_URL", "SPACE_PUBLIC_API_URL"):
        if not getattr(settings, field).startswith("https://"):
            errors.append(f"{field} must use HTTPS")
    if errors:
        raise RuntimeError("Invalid Space configuration: " + "; ".join(errors))

validate_runtime_settings()
