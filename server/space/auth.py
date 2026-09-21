"""Cloud-verified identities with a bounded cache; no cloud login secret on DS."""
import datetime as dt
from config import settings

from fastapi import Depends, HTTPException, Request, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from space.database import get_db
from space import models
from space.integrations.account_client import identity

security = HTTPBearer()

def resolve_identity(db, credential, *, allow_api_key=False):
    if credential.startswith("edapi_") and not allow_api_key:
        raise HTTPException(401, detail={"code": "ACCOUNT_LOGIN_REQUIRED"})
    data = identity(credential)
    account = db.get(models.User, data["id"])
    changed = account is None
    if account is None:
        account = models.User(id=data["id"])
        db.add(account)
    for field in ("username", "skin_url", "skin_type"):
        if getattr(account, field) != data[field]:
            setattr(account, field, data[field])
            changed = True
    if changed:
        account.updated_at = dt.datetime.now(dt.timezone.utc)
        # Authentication runs before route mutations. Concurrent first login
        # can insert the same projection; reload the winning committed row.
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            account = db.get(models.User, data["id"])
            if account is None:
                raise
    # Money, privileges and credential scope are never persisted locally.
    account.credits = data["credits"]
    account.api_key_count = data["api_key_count"]
    account.is_admin = data["is_admin"]
    return account, data.get("scopes")

def get_current_user(request: Request, credentials: HTTPAuthorizationCredentials = Security(security),
                     db: Session = Depends(get_db)):
    user = resolve_identity(db, credentials.credentials)[0]
    request.state.rate_limit_principal = f"user:{user.id}"
    return user

def get_current_admin(user=Depends(get_current_user)):
    if not user.is_admin:
        raise HTTPException(403, detail="Administrator access required")
    return user
