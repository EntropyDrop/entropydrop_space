#!/usr/bin/env python3
"""Provision synthetic Space players through the local account service's models."""

import argparse
from datetime import timezone
import json
import os
from pathlib import Path
import sys
import tempfile
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
ACCOUNT_ROOT = ROOT.parent / "entropydrop_backend"
SESSION_DIR = ROOT / ".local" / "space-test-accounts"
DEV_ORIGIN = "https://space-dev-908123.entropydrop.com"
ACCOUNT_COUNT = 100


def player_email(number):
    return f"space-player-{number:03d}@space-test.invalid"


def require_development_database(settings):
    from sqlalchemy.engine import make_url

    if settings.STRICT_CONFIG_VALIDATION or settings.ENVIRONMENT.strip().lower() not in {
        "development", "dev", "local",
    }:
        raise RuntimeError("Space test accounts require development account settings.")
    url = make_url(settings.DATABASE_URL)
    if url.get_backend_name() == "sqlite":
        return
    if url.get_backend_name() != "postgresql" or url.host not in {"localhost", "127.0.0.1", "::1"}:
        raise RuntimeError("Space test accounts require a local account database.")
    # A libpq service or host override could redirect a loopback URL elsewhere.
    if any(key in url.query for key in ("host", "hostaddr", "service")) or os.environ.get("PGHOSTADDR"):
        raise RuntimeError("Use a direct loopback address for the development account database.")


def find_players(db, user_model, numbers):
    emails = [player_email(number) for number in numbers]
    players = db.query(user_model).filter(user_model.email.in_(emails)).all()
    if any(player.google_id is not None or player.is_admin or player.is_creator for player in players):
        raise RuntimeError("A reserved test email belongs to an account with incompatible privileges.")
    return {player.email: player for player in players}


def provision_players(db, user_model):
    from sqlalchemy.exc import IntegrityError

    numbers = range(1, ACCOUNT_COUNT + 1)
    players = find_players(db, user_model, numbers)
    missing = [number for number in numbers if player_email(number) not in players]
    db.add_all(user_model(email=player_email(number), username=f"Space Player {number:03d}") for number in missing)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if len(find_players(db, user_model, numbers)) != ACCOUNT_COUNT:
            raise
        return 0  # Another provisioner has already committed the same roster.
    return len(missing)


def save_storage_state(path, state):
    descriptor, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(state, output)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def export_sessions(db, user_model, auth, settings, numbers, *, local):
    players = find_players(db, user_model, numbers)
    if len(players) != len(numbers):
        raise RuntimeError("Run the seed command before exporting Space test sessions.")
    if not settings.JWT_SECRET_KEY:
        raise RuntimeError("The development account service must have a JWT signing key.")

    directories = (SESSION_DIR, SESSION_DIR / "localhost") if local else (SESSION_DIR,)
    for directory in directories:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if directory.is_symlink() or directory.stat().st_mode & 0o077:
            raise RuntimeError(f"Space test sessions require a private directory at {directory}.")
    directory = directories[-1]

    space_origin = "http://localhost:5173" if local else DEV_ORIGIN
    account_origin = "http://localhost:8000" if local else DEV_ORIGIN
    account_url = urlsplit(account_origin)
    for number in numbers:
        player = players[player_email(number)]
        session, refresh_cookie = auth.create_auth_session(db, player.id)
        token = auth.create_access_token({"sub": player.id}, session_id=session.id)
        expires_at = session.expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        save_storage_state(directory / f"player-{number:03d}.json", {
            "cookies": [{
                "name": settings.AUTH_SESSION_COOKIE_NAME,
                "value": refresh_cookie,
                "domain": account_url.hostname,
                "path": "/api/auth",
                "expires": expires_at.timestamp(),
                "httpOnly": True,
                "secure": account_url.scheme == "https" or settings.AUTH_SESSION_COOKIE_SECURE,
                "sameSite": "Lax",
            }],
            "origins": [{"origin": space_origin, "localStorage": [{"name": "token", "value": token}]}],
        })
    return directory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("seed", help="Create or reuse all 100 development accounts")
    sessions = commands.add_parser("sessions", help="Export signed Playwright storage states")
    sessions.add_argument("--first", type=int, default=1, help="First player number, starting at 1")
    sessions.add_argument("--count", type=int, default=1, help="Number of consecutive players to export")
    sessions.add_argument("--local", action="store_true", help="Use localhost:5173 and localhost:8000")
    args = parser.parse_args()
    if args.command == "sessions" and not (1 <= args.first <= args.first + args.count - 1 <= ACCOUNT_COUNT):
        parser.error("The requested player numbers must be between 1 and 100.")

    # Import account code in its own checkout and configuration, outside the Space service.
    if not (ACCOUNT_ROOT / "auth.py").is_file():
        parser.error("The sibling entropydrop_backend checkout is required.")
    os.chdir(ACCOUNT_ROOT)
    env_file = Path(os.environ.get("ENV_FILE", ".env"))
    if "prod" in env_file.name.lower() or "prod" in env_file.resolve().name.lower():
        parser.error("Use the development account environment file.")
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(ACCOUNT_ROOT))
    try:
        from config import settings
        from sqlalchemy.exc import SQLAlchemyError
    except ImportError:
        parser.error("Run this command with the account backend virtualenv.")

    try:
        require_development_database(settings)
        import auth
        from database import SessionLocal
        from models import User

        with SessionLocal() as db:
            if args.command == "seed":
                created = provision_players(db, User)
                print(f"{ACCOUNT_COUNT} development players ready ({created} created).")
            else:
                numbers = range(args.first, args.first + args.count)
                directory = export_sessions(db, User, auth, settings, numbers, local=args.local)
                print(f"Exported {len(numbers)} Playwright sessions to {directory.relative_to(ROOT)}.")
    except RuntimeError as error:
        parser.exit(1, f"{error}\n")
    except SQLAlchemyError:
        parser.exit(1, "Could not access the development accounts. Check the local database and account migrations.\n")


if __name__ == "__main__":
    main()
