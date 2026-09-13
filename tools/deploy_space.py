#!/usr/bin/env python3
"""Deploy the independent Space repository to isolated DS development services."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, build_opener
import uuid


HOST = "ds@192.168.0.111"
REMOTE_HOME = Path("/home/ds")
ROOT = Path(__file__).resolve().parents[1]
REPOSITORIES = {
    "space": "entropydrop_space",
}
DEV_WORLD = "00000000-0000-4000-8000-000000000002"
ENVIRONMENTS = {
    "dev": {"prefix": "entropydrop-space-dev", "port": 18081, "workers": 1,
            "db_port": 18432, "database": "space_dev", "redis_port": 18379,
            "account": "http://127.0.0.1:18082", "environment": "development",
            "public": "http://localhost:8000/space/ready"},

}


def run(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def ssh(command, **kwargs):
    return run(["ssh", HOST, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
                shlex.join([str(arg) for arg in command])], **kwargs)


def paths(environment, home=REMOTE_HOME):
    prefix = ENVIRONMENTS[environment]["prefix"]
    return home / ".config" / prefix, home / ".local/share" / prefix


def checkout_root(environment, home=REMOTE_HOME):
    base = home / "github"
    return base if environment == "prod" else base / "entropydrop-space-dev"


def git(path, *args):
    try:
        return run(["git", "-C", path, *args], capture_output=True, text=True).stdout.strip()
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or "").strip() or f"exit status {error.returncode}"
        raise RuntimeError(f"Git {args[0]} failed in {path}: {detail}") from error


def require_clean_checkout(path):
    if path.is_symlink() or not (path / ".git").exists():
        raise RuntimeError(f"Expected a Git checkout at {path}; existing directories are never overwritten.")
    if Path(git(path, "rev-parse", "--show-toplevel")).resolve() != path.resolve():
        raise RuntimeError(f"Expected an independent Git repository at {path}.")
    if git(path, "status", "--porcelain", "--untracked-files=all"):
        raise RuntimeError(f"Uncommitted or untracked files in {path}; commit/stash them before deploying.")


def validate_branch(branch):
    if not branch or branch.startswith("-"):
        raise RuntimeError("A literal Git branch name is required.")
    run(["git", "check-ref-format", f"refs/heads/{branch}"], capture_output=True)


def sync_repository(path, branch, url, accepted_urls=None):
    """Fetch one branch and fast-forward its clean checkout; never reset or discard work."""
    validate_branch(branch)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "clone", "--origin", "origin", "--branch", branch, "--single-branch", url, path])
    require_clean_checkout(path)
    origin = git(path, "remote", "get-url", "origin")
    if origin not in (accepted_urls or {url}):
        raise RuntimeError(f"Unexpected origin in {path}; refusing to deploy another repository.")
    remote_ref = f"refs/remotes/origin/{branch}"
    # Explicit refspec supports branches absent from an earlier --single-branch clone.
    refspec = f"refs/heads/{branch}:{remote_ref}"
    fetch_specs = {value.lstrip("+") for value in git(path, "config", "--get-all", "remote.origin.fetch").splitlines()}
    if refspec not in fetch_specs and "refs/heads/*:refs/remotes/origin/*" not in fetch_specs:
        git(path, "remote", "set-branches", "--add", "origin", branch)
    git(path, "fetch", "--no-tags", "origin", f"+refs/heads/{branch}:{remote_ref}")
    commit = git(path, "rev-parse", "--verify", f"{remote_ref}^{{commit}}")
    local_ref = f"refs/heads/{branch}"
    exists = subprocess.run(["git", "-C", str(path), "show-ref", "--verify", "--quiet", local_ref]).returncode
    if exists == 0:
        ancestor = subprocess.run(["git", "-C", str(path), "merge-base", "--is-ancestor", local_ref, commit]).returncode
        if ancestor != 0:
            raise RuntimeError(f"{path}: {branch} is ahead of or diverged from origin; refusing to overwrite commits.")
        git(path, "switch", branch)
    elif exists == 1:
        git(path, "switch", "--track", "-c", branch, remote_ref)
    else:
        raise RuntimeError(f"Could not inspect branch {branch} in {path}.")
    git(path, "merge", "--ff-only", commit)
    git(path, "branch", f"--set-upstream-to=origin/{branch}", branch)
    require_clean_checkout(path)
    if git(path, "rev-parse", "HEAD") != commit:
        raise RuntimeError(f"{path} did not reach the requested origin commit.")
    return {"path": str(path), "origin": origin, "branch": branch, "commit": commit}


def sync_repositories(environment, branch):
    base = checkout_root(environment, Path.home())
    name = REPOSITORIES["space"]
    url = f"git@github.com:EntropyDrop/{name}.git"
    source = sync_repository(base / name, branch, url, {url, f"https://github.com/EntropyDrop/{name}.git"})
    print(f"[{environment}] {name} {branch} -> {source['commit']}", flush=True)
    return {"space": source}


def verify_repositories(sources):
    for source in sources.values():
        path = Path(source["path"])
        require_clean_checkout(path)
        if git(path, "rev-parse", "HEAD") != source["commit"] or git(path, "branch", "--show-current") != source["branch"]:
            raise RuntimeError(f"Checkout changed during deployment: {path}")


def get_json(url):
    with build_opener(ProxyHandler({})).open(url, timeout=5) as response:
        return json.load(response)


def require_ready(url):
    if get_json(url).get("status") != "ready":
        raise RuntimeError(f"Space is not ready: {url}")


def docker_inspect(name):
    # Never print full Docker inspect output: Config.Env contains private credentials.
    result = run(["docker", "container", "inspect", name], capture_output=True, text=True)
    return json.loads(result.stdout)[0]


def validate_env(config, environment):
    expected = ENVIRONMENTS[environment]
    for role in ("app", "worker"):
        file = config / f"{role}.env"
        values = {}
        for line in file.read_text().splitlines():
            key, separator, value = line.partition("=")
            if separator and not line.lstrip().startswith("#"):
                values[key.strip()] = value.strip().strip("\"'")
        checks = {
            "ENVIRONMENT": expected["environment"], "SPACE_STANDALONE": "true",
            "SPACE_ACCOUNT_API_URL": expected["account"],
            "SPACE_OBJECT_DIR": "/var/lib/space/objects",
        }
        if role == "worker":
            checks["SPACE_HOSTING_ENABLED"] = "true"
        if environment == "dev":
            checks["SPACE_DEFAULT_WORLD_ID"] = DEV_WORLD
        for key, value in checks.items():
            if values.get(key) != value:
                raise RuntimeError(f"{file}: {key} does not match the {environment} deployment.")
        for key, port, database in (("DATABASE_URL", expected["db_port"], expected["database"]),
                                    ("REDIS_URL", expected["redis_port"], "0")):
            url = urlsplit(values.get(key, ""))
            if url.hostname not in ("127.0.0.1", "localhost") or url.port != port or url.path != f"/{database}":
                raise RuntimeError(f"{file}: {key} does not point to the isolated {environment} database/cache.")


def save_state(path, state):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


@contextmanager
def deployment_lock(data):
    import fcntl  # DS and the development Mac both support flock.
    data.mkdir(parents=True, exist_ok=True)
    with (data / "deploy.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another deployment is already running for this environment.")
        yield


def container_command(environment, role, image, config, data, release):
    settings = ENVIRONMENTS[environment]
    command = ["uvicorn", "space.main:app", "--host", "127.0.0.1", "--port", str(settings["port"]),
               "--workers", str(settings["workers"]), "--no-access-log", "--no-proxy-headers"]
    if role == "worker":
        command = ["python", "-m", "space.hosting_worker"]
    return [
        "docker", "run", "-d", "--name", f"{settings['prefix']}-{role}",
        "--restart", "unless-stopped", "--network", "host", "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--memory", "1g", "--cpus", "2",
        "--pids-limit", "128", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
        "--label", f"entropydrop.space.environment={environment}",
        "--label", f"entropydrop.space.release={release}",
        "--env-file", str(config / ("worker.env" if role == "worker" else "app.env")),
        "-v", f"{data / 'objects'}:/var/lib/space/objects", image, *command,
    ]


def wait_for_apps(environment, image, timeout=90, settle=10):
    settings = ENVIRONMENTS[environment]
    deadline, healthy_since = time.monotonic() + timeout, None
    while time.monotonic() < deadline:
        containers = [docker_inspect(f"{settings['prefix']}-{role}") for role in ("api", "worker")]
        if any(c["Image"] != image or c["RestartCount"] != 0 or not c["State"]["Running"] for c in containers):
            raise RuntimeError("New Space containers exited, restarted, or run an unexpected image.")
        try:
            require_ready(f"http://127.0.0.1:{settings['port']}/space/ready")
        except (OSError, ValueError, RuntimeError):
            healthy_since = None
        else:
            healthy_since = healthy_since if healthy_since is not None else time.monotonic()
            if time.monotonic() - healthy_since >= settle:
                return
        time.sleep(2)
    raise RuntimeError("Space API/worker did not stabilize before the readiness timeout.")


def ensure_dev_infrastructure(config):
    """Use the existing isolated development volumes and validated DS image IDs."""
    names = set(run(["docker", "ps", "-a", "--format", "{{.Names}}"], capture_output=True, text=True).stdout.splitlines())
    for role in ("postgres", "redis"):
        name = f"entropydrop-space-dev-{role}"
        if name in names:
            run(["docker", "start", name])
            continue
        volume = f"{name}-data"
        run(["docker", "volume", "create", volume])
        common = ["docker", "run", "-d", "--name", name, "--restart", "unless-stopped",
                  "--log-opt", "max-size=10m", "--log-opt", "max-file=3"]
        if role == "postgres":
            run([*common, "--cpus", "2", "--memory", "2g", "--shm-size", "256m", "--pids-limit", "128",
                 "-p", "127.0.0.1:18432:5432", "--env-file", config / "postgres.env",
                 "-v", f"{volume}:/var/lib/postgresql/data", "--health-cmd", "pg_isready -U space_dev -d space_dev",
                 "--health-interval", "10s", "sha256:aad6289ca337b3ce76896f2e7e61480490152886c7828120371fb28e6b779e1d",
                 "postgres", "-c", "shared_buffers=256MB", "-c", "max_connections=60"])
        else:
            run([*common, "--cpus", "1", "--memory", "512m", "--pids-limit", "64",
                 "-p", "127.0.0.1:18379:6379", "-v", f"{volume}:/data",
                 "-v", f"{config / 'redis.conf'}:/usr/local/etc/redis/redis.conf:ro",
                 "sha256:5509c0097c6064aa8a3b1df58f1d950e67090fffa6678ae8f3f1dc2385f12deb",
                 "redis-server", "/usr/local/etc/redis/redis.conf"])
    for _ in range(40):
        result = subprocess.run(["docker", "exec", "entropydrop-space-dev-postgres", "pg_isready",
                                 "-U", "space_dev", "-d", "space_dev"], capture_output=True)
        if result.returncode == 0:
            return
        time.sleep(1)
    raise RuntimeError("Development PostgreSQL did not become ready.")


def remote_deploy(environment, branch="main", quiesce=False):
    settings = ENVIRONMENTS[environment]
    config, data = paths(environment, Path.home())
    release = f"{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:12]}"
    directory = data / "releases" / release
    state = {"release": release, "environment": environment, "previous": {}, "phase": "preflight",
             "requested_branches": {"space": branch}}
    state_path = directory / "deployment.json"

    def phase(name):
        state["phase"] = name
        save_state(state_path, state)
        print(f"[{environment}] {name}", flush=True)

    with deployment_lock(data):
        directory.mkdir(parents=True, mode=0o700)
        validate_env(config, environment)
        if environment == "dev":
            if get_json(f"{settings['account']}/skin/api/health").get("status") != "ok":
                raise RuntimeError("The Mac account API is unavailable through the development tunnel.")
        try:
            phase("Git sync")
            sources = sync_repositories(environment, branch)
            state["sources"] = sources
            save_state(directory / "manifest.json", {"release": release, "environment": environment, "sources": sources})
            build_context = Path(sources["space"]["path"])
            verify_repositories(sources)
            phase("build")
            tag = f"entropydrop-space-{environment}:{release}"
            # DS exposes the FRP HTTP proxy only on loopback. Host networking
            # makes it reachable from RUN steps; daemon pulls have separate config.
            run(["docker", "build", "--target", "runtime", "--network", "host",
                 "--build-arg", "HTTP_PROXY=http://127.0.0.1:19100",
                 "--build-arg", "HTTPS_PROXY=http://127.0.0.1:19100",
                 "--build-arg", "http_proxy=http://127.0.0.1:19100",
                 "--build-arg", "https_proxy=http://127.0.0.1:19100",
                 "--build-arg", "NO_PROXY=localhost,127.0.0.1,::1",
                 "--build-arg", "no_proxy=localhost,127.0.0.1,::1",
                 "--label", f"entropydrop.space.commit={sources['space']['commit']}",
                 "-f", "deploy/Dockerfile", "-t", tag, "."], cwd=build_context)
            verify_repositories(sources)
            image = run(["docker", "image", "inspect", "--format", "{{.Id}}", tag], capture_output=True, text=True).stdout.strip()
            state["image"], state["tag"] = image, tag
            phase("native smoke test")
            run(["docker", "run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp",
                 "--memory", "1g", "--cpus", "2", "--pids-limit", "128", "--cap-drop", "ALL",
                 "--security-opt", "no-new-privileges:true", "-e", "ENV_FILE=/nonexistent",
                 "-e", "DATABASE_URL=sqlite:///:memory:", image, "python", "-m", "space.hosting_smoke"])
            phase("infrastructure")
            if environment == "dev":
                ensure_dev_infrastructure(config)
                (data / "objects").mkdir(parents=True, exist_ok=True)
                run(["docker", "run", "--rm", "--network", "none", "--user", "0", "--cap-drop", "ALL",
                     "--cap-add", "CHOWN", "-v", f"{data / 'objects'}:/objects", image,
                     "chown", "10001:10001", "/objects"])
            for role in ("postgres", "redis"):
                if not docker_inspect(f"{settings['prefix']}-{role}")["State"]["Running"]:
                    raise RuntimeError(f"{environment} {role} is not running.")
            existing_names = set(run(["docker", "ps", "-a", "--format", "{{.Names}}"],
                                     capture_output=True, text=True).stdout.splitlines())
            for role in ("api", "worker"):
                name = f"{settings['prefix']}-{role}"
                if name in existing_names:
                    previous = docker_inspect(name)
                    state["previous"][role] = {"name": name, "id": previous["Id"], "image": previous["Image"],
                                                "retained": f"{name}-before-{release}"}
            if quiesce:
                phase("quiesce Space writers")
                for role in ("worker", "api"):
                    previous = state["previous"].get(role)
                    if previous:
                        run(["docker", "update", "--restart=no", previous["id"]])
                        run(["docker", "stop", "--time", "30", previous["id"]])
                state["quiesced"] = True
                save_state(state_path, state)
            phase("Space schema migration")
            run(["docker", "run", "--rm", "--network", "host", "--env-file", config / "app.env",
                 image, "python", "-m", "alembic", "-c", "space/alembic.ini", "upgrade", "head"])
            if environment == "dev":
                run(["docker", "run", "--rm", "--network", "host", "--env-file", config / "app.env", image,
                     "python", "-c", "from config import settings; from space.database import SessionLocal; "
                     "from routers.space import _get_or_create_default_world; "
                     f"assert settings.SPACE_STANDALONE and settings.SPACE_DEFAULT_WORLD_ID == '{DEV_WORLD}'; "
                     "db = SessionLocal(); _get_or_create_default_world(db); db.commit(); db.close()"])
            phase("replace API and worker")
            # Retained containers must not restart next to the new worker after a DS reboot.
            for role in ("worker", "api"):
                previous = state["previous"].get(role)
                if previous:
                    run(["docker", "update", "--restart=no", previous["id"]])
                    run(["docker", "stop", "--time", "30", previous["id"]])
                    run(["docker", "rename", previous["id"], previous["retained"]])
            for role in ("api", "worker"):
                run(container_command(environment, role, image, config, data, release))
            phase("readiness")
            wait_for_apps(environment, image)
            phase("DS ready")
            save_state(data / "current-release.json", state)
        except BaseException as error:
            state["failed_phase"] = state["phase"]
            state["phase"] = "failed"
            # Exceptions are not persisted: database failures can contain credential-bearing URLs.
            state["error_type"] = type(error).__name__
            save_state(state_path, state)
            print(f"Release failed; inspect {state_path}. Old containers and data are retained. "
                  "Do not roll back schema automatically.", file=sys.stderr, flush=True)
            raise


def remote_status(environment):
    settings = ENVIRONMENTS[environment]
    config, _ = paths(environment, Path.home())
    validate_env(config, environment)
    for role in ("api", "worker", "postgres", "redis"):
        container = docker_inspect(f"{settings['prefix']}-{role}")
        print(json.dumps({"name": container["Name"].lstrip("/"), "image": container["Config"]["Image"],
                          "status": container["State"]["Status"], "restarts": container["RestartCount"]}), flush=True)
        if not container["State"]["Running"]:
            raise RuntimeError(f"{environment} {role} is not running.")
    require_ready(f"http://127.0.0.1:{settings['port']}/space/ready")


def dev_helper(action):
    run([sys.executable, ROOT.parent / "entropydrop_backend/deploy/space-dev/dev.py", action])


def local_deploy(environment, dry_run=False, branch="main", quiesce=False):
    base = checkout_root(environment)
    print(f"{environment}: {HOST}\nSpace: {base / REPOSITORIES['space']} @ origin/{branch}", flush=True)
    if dry_run:
        print("Plan: Git fetch + fast-forward on DS -> build -> native smoke -> infrastructure -> "
              + ("stop Space writers -> " if quiesce else "")
              + ("production backup -> " if environment == "prod" else "")
              + "Space migration -> replace API/worker -> readiness -> gateway check")
        return
    if environment == "dev":
        if get_json("http://localhost:8000/skin/api/health").get("status") != "ok":
            raise RuntimeError("Start the Mac development account API on port 8000 first.")
        dev_helper("tunnel")
    # Transport only the deployment driver. All application code comes from Git on DS.
    ssh(["python3", "-", environment, "deploy", "--remote", "--branch", branch, *(["--quiesce"] if quiesce else [])], input=Path(__file__).read_bytes())
    require_ready(ENVIRONMENTS[environment]["public"])
    print(f"[DONE] Space {environment}; DS and gateway readiness passed. Commit IDs are in current-release.json.", flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("environment", choices=ENVIRONMENTS)
    parser.add_argument("action", nargs="?", default="deploy", choices=("deploy", "status", "setup", "tunnel"))
    parser.add_argument("--branch", default="main", help="Space remote branch (default: main).")
    parser.add_argument("--dry-run", action="store_true", help="Print Git checkout paths, branches and deployment plan without connecting to DS.")
    parser.add_argument("--quiesce", action="store_true", help="Stop API and worker before backup/migration for a breaking schema change; leave stopped on failure.")
    parser.add_argument("--remote", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.quiesce and args.action != "deploy":
        parser.error("--quiesce requires a deploy action")
    if args.dry_run and (args.action != "deploy" or args.remote):
        parser.error("--dry-run is only supported for local deploy commands")
    if args.action in ("setup", "tunnel") and (args.environment != "dev" or args.remote):
        parser.error("setup and tunnel are only supported for local dev commands")
    if args.remote:
        if args.action == "deploy":
            remote_deploy(args.environment, args.branch, **({"quiesce": True} if args.quiesce else {}))
        else:
            remote_status(args.environment)
    elif args.action in ("setup", "tunnel"):
        dev_helper(args.action)
    elif args.action == "status":
        ssh(["python3", "-", args.environment, "status", "--remote"], input=Path(__file__).read_bytes())
        require_ready(ENVIRONMENTS[args.environment]["public"])
        print("DS and gateway readiness passed.")
    else:
        local_deploy(args.environment, args.dry_run, args.branch, **({"quiesce": True} if args.quiesce else {}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"[FAILED] {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
