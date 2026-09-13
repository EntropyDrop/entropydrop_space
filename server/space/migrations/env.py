from alembic import context
from config import settings
from space.database import Base, engine
from space import models



def migrate(connection=None):
    context.configure(connection=connection, url=settings.DATABASE_URL,
        target_metadata=Base.metadata, version_table="space_alembic_version",
        literal_binds=connection is None)
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    migrate()
else:
    with engine.begin() as connection:
        migrate(connection)
