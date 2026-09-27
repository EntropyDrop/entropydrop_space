#!/usr/bin/env python3
"""Build the production Space client and main site with explicit public origins."""
import os
import subprocess
from pathlib import Path

from dotenv import dotenv_values


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "entropydrop_backend"
FRONTEND = ROOT / "entropydrop_frontend"
SPACE = ROOT / "entropydrop_space"


def main():
    settings = dotenv_values(BACKEND / ".env.prod")
    google_client_id = (settings.get("GOOGLE_CLIENT_ID") or "").strip()
    if not google_client_id.endswith(".apps.googleusercontent.com"):
        raise RuntimeError("Production GOOGLE_CLIENT_ID is missing or invalid")
    env = {
        **os.environ,
        "VITE_API_BASE_URL": "https://api.entropydrop.com",
        "VITE_SPACE_API_BASE_URL": "https://space.entropydrop.com",
        "VITE_MAIN_SITE_ORIGIN": "https://entropydrop.com",
        "VITE_SPACE_URL": "https://space.entropydrop.com/",
        "VITE_GOOGLE_CLIENT_ID": google_client_id,
    }
    subprocess.run(["npm", "run", "build"], cwd=SPACE, env=env, check=True)
    subprocess.run(["npm", "run", "build"], cwd=FRONTEND, env=env, check=True)


if __name__ == "__main__":
    main()
