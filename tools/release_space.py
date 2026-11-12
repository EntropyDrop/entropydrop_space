#!/usr/bin/env python3
"""Unified release CLI for Space.

Allows developers to publish client updates in ~1.5 minutes without unnecessary
backend builds or full site republishing, or run coordinated releases when needed.

Usage:
    # 1. Client-only static release (Fastest, ~1.5 min):
    python tools/release_space.py client

    # 2. Backend service release (DS API & worker):
    python tools/release_space.py server

    # 3. Full release (DS backend deploy + Space client build & CDN switch):
    python tools/release_space.py full

    # 4. Main site release (entropydrop.com frontend):
    python tools/release_space.py main-site
"""
import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PYTHON = sys.executable


def run(cmd, **kwargs):
    print(f"\n==> Running: {' '.join(str(c) for c in cmd)}\n", flush=True)
    subprocess.run([str(c) for c in cmd], check=True, **kwargs)


def release_client(release=None, timeout=900):
    run([PYTHON, ROOT / "build_prod_domain.py", "--target", "space"])
    prepare_cmd = [PYTHON, ROOT / "deploy_domain.py", "prepare", "--timeout", str(timeout)]
    if release:
        prepare_cmd.extend(["--release", release])
    run(prepare_cmd)


def release_server(environment="prod", branch="main", quiesce=False, dry_run=False):
    cmd = [PYTHON, ROOT / "deploy_space.py", environment]
    if branch != "main":
        cmd.extend(["--branch", branch])
    if quiesce:
        cmd.append("--quiesce")
    if dry_run:
        cmd.append("--dry-run")
    run(cmd)


def release_main_site(timeout=900):
    run([PYTHON, ROOT / "build_prod_domain.py", "--target", "frontend"])
    run([PYTHON, ROOT / "deploy_domain.py", "upload-main", "--timeout", str(timeout)])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    subparsers = parser.add_subparsers(dest="target", required=True, help="Release target")

    # client
    client_p = subparsers.add_parser("client", help="Build and publish Space static client to CloudFront (~1.5m).")
    client_p.add_argument("--release", help="Release identifier (default: auto-generated timestamp).")
    client_p.add_argument("--timeout", type=int, default=900, help="CDN propagation timeout in seconds.")

    # server
    server_p = subparsers.add_parser("server", help="Deploy DS backend services (migrations, API, worker).")
    server_p.add_argument("--env", default="prod", choices=["prod", "dev"], help="Target environment (default: prod).")
    server_p.add_argument("--branch", default="main", help="Git branch to deploy (default: main).")
    server_p.add_argument("--quiesce", action="store_true", help="Stop writers before migration for breaking schema change.")
    server_p.add_argument("--dry-run", action="store_true", help="Print plan without deploying.")

    # full
    full_p = subparsers.add_parser("full", help="Full release: DS backend deploy + client build & CloudFront switch.")
    full_p.add_argument("--release", help="Release identifier (default: auto-generated timestamp).")
    full_p.add_argument("--env", default="prod", choices=["prod", "dev"], help="Target environment (default: prod).")
    full_p.add_argument("--branch", default="main", help="Git branch to deploy (default: main).")
    full_p.add_argument("--quiesce", action="store_true", help="Stop writers before migration.")
    full_p.add_argument("--timeout", type=int, default=900, help="CDN propagation timeout in seconds.")

    # main-site
    main_p = subparsers.add_parser("main-site", help="Build and publish main site frontend (entropydrop.com).")
    main_p.add_argument("--timeout", type=int, default=900, help="CDN propagation timeout in seconds.")

    args = parser.parse_args(argv)

    if args.target == "client":
        release_client(release=args.release, timeout=args.timeout)
    elif args.target == "server":
        release_server(environment=args.env, branch=args.branch, quiesce=args.quiesce, dry_run=args.dry_run)
    elif args.target == "full":
        release_server(environment=args.env, branch=args.branch, quiesce=args.quiesce)
        release_client(release=args.release, timeout=args.timeout)
    elif args.target == "main-site":
        release_main_site(timeout=args.timeout)


if __name__ == "__main__":
    main()
