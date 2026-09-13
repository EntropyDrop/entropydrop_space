"""Offline regression coverage for the Space deployment tool; no live mutations."""
from contextlib import ExitStack
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("deploy_space", Path(__file__).with_name("deploy_space.py"))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
RELEASE = "20260907T000000Z-0123456789ab-abcdef"


class SpaceTestCase(unittest.TestCase):
    def setUp(self):
        self.contexts = ExitStack()
        self.addCleanup(self.contexts.close)
        self.temporary = Path(self.contexts.enter_context(tempfile.TemporaryDirectory()))

    def mock(self, name, **kwargs):
        return self.contexts.enter_context(patch.object(deploy, name, **kwargs))


class GitSourceTests(SpaceTestCase):
    def setUp(self):
        super().setUp()
        self.origin = self.temporary / "origin.git"
        self.seed = self.temporary / "seed"
        self.checkout = self.temporary / "checkout"
        self.command("init", "--bare", "--initial-branch=main", self.origin)
        self.command("clone", self.origin, self.seed)
        self.command("-C", self.seed, "config", "user.email", "deploy-test@example.invalid")
        self.command("-C", self.seed, "config", "user.name", "Deployment Test")
        self.publish("initial")

    def command(self, *args):
        return subprocess.run(["git", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
                               *map(str, args)], check=True, capture_output=True, text=True).stdout.strip()

    def publish(self, value, branch="main"):
        (self.seed / "source.py").write_text(value)
        self.command("-C", self.seed, "add", "source.py")
        self.command("-C", self.seed, "commit", "-m", value)
        self.command("-C", self.seed, "push", "origin", branch)
        return self.command("-C", self.seed, "rev-parse", "HEAD")

    def sync(self, branch="main"):
        return deploy.sync_repository(self.checkout, branch, str(self.origin))

    def test_clone_then_fast_forward_records_exact_remote_commit(self):
        self.sync()
        expected = self.publish("remote update")
        result = self.sync()
        self.assertEqual(result["commit"], expected)
        self.assertEqual((self.checkout / "source.py").read_text(), "remote update")
        self.assertEqual(self.command("-C", self.checkout, "rev-parse", "@{upstream}"), expected)

    def test_switch_to_another_remote_branch_after_single_branch_clone(self):
        self.sync()
        self.command("-C", self.seed, "switch", "-c", "feature/api")
        expected = self.publish("feature", "feature/api")
        result = self.sync("feature/api")
        self.assertEqual(result["branch"], "feature/api")
        self.assertEqual(result["commit"], expected)
        self.assertEqual(self.command("-C", self.checkout, "rev-parse", "@{upstream}"), expected)

    def test_dirty_checkout_is_preserved(self):
        self.sync()
        file = self.checkout / "source.py"
        file.write_text("local work")
        with self.assertRaisesRegex(RuntimeError, "Uncommitted"):
            self.sync()
        self.assertEqual(file.read_text(), "local work")

    def test_local_commits_are_not_silently_published_or_reset(self):
        self.sync()
        (self.checkout / "source.py").write_text("local commit")
        self.command("-C", self.checkout, "add", "source.py")
        self.command("-C", self.checkout, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                     "commit", "-m", "local commit")
        previous = self.command("-C", self.checkout, "rev-parse", "HEAD")
        with self.assertRaisesRegex(RuntimeError, "ahead of or diverged"):
            self.sync()
        self.assertEqual(self.command("-C", self.checkout, "rev-parse", "HEAD"), previous)

    def test_non_git_snapshot_directory_is_never_overwritten(self):
        self.checkout.mkdir()
        file = self.checkout / "precious.txt"
        file.write_text("keep")
        with self.assertRaisesRegex(RuntimeError, "Git checkout"):
            self.sync()
        self.assertEqual(file.read_text(), "keep")

    def test_wrong_origin_or_missing_branch_stops_release(self):
        self.sync()
        with self.assertRaisesRegex(RuntimeError, "Unexpected origin"):
            deploy.sync_repository(self.checkout, "main", "https://example.invalid/wrong.git")
        with self.assertRaisesRegex(RuntimeError, "Git fetch failed"):
            self.sync("missing-branch")

    def test_checkout_change_during_build_is_rejected(self):
        source = self.sync()
        deploy.verify_repositories({"backend": source})
        (self.checkout / "source.py").write_text("concurrent edit")
        with self.assertRaisesRegex(RuntimeError, "Uncommitted"):
            deploy.verify_repositories({"backend": source})


class DispatchTests(SpaceTestCase):
    def test_dry_run_has_no_shell_or_network_effects(self):
        shell, tunnel, network = self.mock("run"), self.mock("dev_helper"), self.mock("get_json")
        for environment in ("dev", "prod"):
            deploy.local_deploy(environment, dry_run=True)
        shell.assert_not_called()
        tunnel.assert_not_called()
        network.assert_not_called()

    def test_only_driver_is_sent_and_branches_reach_ds(self):
        remote = self.mock("ssh")
        self.mock("require_ready")
        driver = Path(deploy.__file__)
        def read_bytes(path):
            self.assertEqual(path, driver)
            return b"# deployment driver"
        with patch.object(Path, "read_bytes", autospec=True, side_effect=read_bytes):
            deploy.local_deploy("prod", branch="release/space")
        remote.assert_called_once()
        self.assertEqual(remote.call_args.kwargs["input"], b"# deployment driver")
        self.assertEqual(remote.call_args.args[0], ["python3", "-", "prod", "deploy", "--remote",
                         "--branch", "release/space"])

    def test_cli_defaults_and_per_repo_overrides(self):
        dispatch = self.mock("local_deploy")
        deploy.main(["dev", "--branch", "feature/shared"])
        dispatch.assert_called_once_with("dev", False, "feature/shared")

    def test_legacy_sync_delegates_instead_of_uploading_source(self):
        legacy_path = Path(deploy.__file__).parents[1] .parent / "entropydrop_backend/deploy/space-dev/dev.py"
        legacy_spec = importlib.util.spec_from_file_location("space_dev_legacy", legacy_path)
        legacy = importlib.util.module_from_spec(legacy_spec)
        legacy_spec.loader.exec_module(legacy)
        with patch.object(legacy, "run") as execute, patch.object(legacy, "ssh") as remote:
            legacy.sync()
        execute.assert_called_once_with([legacy.sys.executable, legacy.ROOT / "tools/deploy_space.py", "dev"])
        remote.assert_not_called()

    def test_dev_checkout_does_not_switch_the_production_repositories(self):
        prod = deploy.checkout_root("prod", self.temporary)
        dev = deploy.checkout_root("dev", self.temporary)
        self.assertEqual(prod, self.temporary / "github")
        self.assertEqual(dev, self.temporary / "github/entropydrop-space-dev")


class IsolationTests(SpaceTestCase):
    def write_env(self, environment):
        settings = deploy.ENVIRONMENTS[environment]
        values = {
            "ENVIRONMENT": settings["environment"], "SPACE_STANDALONE": "true",
            "SPACE_ACCOUNT_API_URL": settings["account"], "SPACE_OBJECT_DIR": "/var/lib/space/objects",
            "SPACE_HOSTING_ENABLED": "true", "SPACE_DEFAULT_WORLD_ID": deploy.DEV_WORLD,
            "DATABASE_URL": f"postgresql://user:SECRET@127.0.0.1:{settings['db_port']}/{settings['database']}",
            "REDIS_URL": f"redis://:SECRET@127.0.0.1:{settings['redis_port']}/0",
        }
        for role in ("app", "worker"):
            (self.temporary / f"{role}.env").write_text("\n".join(f"{key}={value}" for key, value in values.items()))

    def test_environment_cannot_use_the_other_database(self):
        self.write_env("prod")
        deploy.validate_env(self.temporary, "prod")
        with self.assertRaises(RuntimeError) as error:
            deploy.validate_env(self.temporary, "dev")
        self.assertNotIn("SECRET", str(error.exception))
        self.write_env("dev")
        file = self.temporary / "worker.env"
        file.write_text(file.read_text().replace(":18432/space_dev", ":25432/space"))
        with self.assertRaisesRegex(RuntimeError, "DATABASE_URL"):
            deploy.validate_env(self.temporary, "dev")

    def test_container_names_ports_and_volumes_are_isolated(self):
        for environment in ("dev", "prod"):
            config, data = deploy.paths(environment)
            commands = [deploy.container_command(environment, role, "sha256:image", config, data, RELEASE)
                        for role in ("api", "worker")]
            settings = deploy.ENVIRONMENTS[environment]
            self.assertIn(str(settings["port"]), commands[0])
            for role, command in zip(("api", "worker"), commands):
                self.assertEqual(command[command.index("--name") + 1], f"{settings['prefix']}-{role}")
                self.assertIn(f"{data / 'objects'}:/var/lib/space/objects", command)
                self.assertIn("sha256:image", command)
                self.assertFalse(any(".env.prod" in str(arg) for arg in command))

    def test_concurrent_deployment_is_rejected(self):
        with deploy.deployment_lock(self.temporary):
            with self.assertRaisesRegex(RuntimeError, "already running"):
                with deploy.deployment_lock(self.temporary):
                    self.fail("Second deployment acquired the same lock")

    def test_setup_is_never_allowed_for_production(self):
        helper = self.mock("dev_helper")
        with self.assertRaises(SystemExit):
            deploy.main(["prod", "setup"])
        helper.assert_not_called()


class RemoteRolloutTests(SpaceTestCase):
    def setUp(self):
        super().setUp()
        self.config, self.data = self.temporary / "config", self.temporary / "data"
        (self.data / "objects").mkdir(parents=True)
        self.mock("paths", return_value=(self.config, self.data))
        self.backend = self.temporary / "checkouts/entropydrop_space"
        backup = self.backend / "deploy/backup-production.sh"
        backup.parent.mkdir(parents=True)
        backup.write_text("# fixture")
        self.sources = {role: {"path": str(self.backend.parent / name), "branch": "main", "commit": role[0] * 40}
                        for role, name in deploy.REPOSITORIES.items()}
        self.sync = self.mock("sync_repositories", return_value=self.sources)
        self.verify = self.mock("verify_repositories")
        self.mock("ensure_dev_infrastructure")
        self.mock("validate_env")
        self.mock("get_json", return_value={"status": "ok"})
        self.actual_wait = deploy.wait_for_apps
        self.wait = self.mock("wait_for_apps")
        self.inspect = self.mock("docker_inspect", side_effect=lambda name: {
            "Id": name, "Image": "sha256:old", "State": {"Running": True},
        })
        self.commands = []
        self.fail_on = None

        def shell(args, **kwargs):
            args = [str(arg) for arg in args]
            self.commands.append(args)
            if args[:2] == ["docker", "build"]:
                self.build_context = kwargs.get("cwd")
            if self.fail_on and self.fail_on(args):
                raise subprocess.CalledProcessError(1, args)
            output = ""
            if args[:3] == ["docker", "image", "inspect"]:
                output = "sha256:new\n"
            elif args[:3] == ["docker", "ps", "-a"]:
                output = "\n".join(f"{prefix}-{role}" for prefix in ("entropydrop-space", "entropydrop-space-dev")
                                   for role in ("api", "worker"))
            return subprocess.CompletedProcess(args, 0, stdout=output)
        self.mock("run", side_effect=shell)

    def index(self, predicate):
        return next(i for i, command in enumerate(self.commands) if predicate(command))

    def test_production_backups_and_migration_precede_replacement(self):
        deploy.remote_deploy("prod")
        smoke = self.index(lambda c: "space.hosting_smoke" in c)
        backup = self.index(lambda c: any(arg.endswith("backup-production.sh") for arg in c))
        migrate = self.index(lambda c: "alembic" in c)
        stop = self.index(lambda c: c[:2] == ["docker", "stop"])
        self.assertLess(smoke, backup)
        self.assertLess(backup, migrate)
        self.assertLess(migrate, stop)
        self.assertFalse(any(c[:2] == ["docker", "rm"] for c in self.commands))
        self.assertTrue(all("space/alembic.ini" in c for c in self.commands if "alembic" in c))
        self.wait.assert_called_once_with("prod", "sha256:new")
        state = json.loads((self.data / "current-release.json").read_text())
        self.assertEqual(state["phase"], "DS ready")
        self.assertEqual(state["sources"], self.sources)
        self.assertEqual(self.build_context, self.backend)

    def test_failed_smoke_backup_or_migration_keeps_old_apps_running(self):
        for predicate in (
            lambda c: "space.hosting_smoke" in c,
            lambda c: any(arg.endswith("backup-production.sh") for arg in c),
            lambda c: "alembic" in c,
        ):
            with self.subTest(stage=predicate):
                self.commands.clear()
                self.fail_on = predicate
                with self.assertRaises(subprocess.CalledProcessError):
                    deploy.remote_deploy("prod")
                self.assertFalse(any(c[:2] in (["docker", "stop"], ["docker", "rename"], ["docker", "update"])
                                     for c in self.commands))
                self.assertFalse((self.data / "current-release.json").exists())

    def test_breaking_release_stops_writers_before_backup_and_migration(self):
        deploy.remote_deploy("prod", quiesce=True)
        stop = self.index(lambda c: c[:2] == ["docker", "stop"])
        backup = self.index(lambda c: any(arg.endswith("backup-production.sh") for arg in c))
        migrate = self.index(lambda c: "alembic" in c)
        self.assertLess(stop, backup)
        self.assertLess(backup, migrate)
        state = json.loads((self.data / "current-release.json").read_text())
        self.assertTrue(state["quiesced"])

    def test_failed_breaking_migration_keeps_old_writers_stopped(self):
        self.fail_on = lambda c: "alembic" in c
        with self.assertRaises(subprocess.CalledProcessError):
            deploy.remote_deploy("prod", quiesce=True)
        self.assertEqual(sum(c[:2] == ["docker", "stop"] for c in self.commands), 2)
        self.assertFalse(any(c[:2] in (["docker", "rename"], ["docker", "start"]) for c in self.commands))
        self.assertFalse((self.data / "current-release.json").exists())

    def test_failed_readiness_retains_previous_containers_and_records_failure(self):
        self.wait.side_effect = RuntimeError("readiness failed")
        with self.assertRaises(RuntimeError):
            deploy.remote_deploy("prod")
        self.assertFalse((self.data / "current-release.json").exists())
        state = json.loads(next((self.data / "releases").glob("*/deployment.json")).read_text())
        self.assertEqual(state["phase"], "failed")
        self.assertEqual(state["failed_phase"], "readiness")
        self.assertEqual(len(state["previous"]), 2)
        self.assertFalse(any(c[:2] == ["docker", "rm"] for c in self.commands))

    def test_dev_does_not_touch_production_apps_or_backups(self):
        deploy.remote_deploy("dev")
        self.assertFalse(any(any(arg.endswith("backup-production.sh") for arg in c) for c in self.commands))
        for c in self.commands:
            if c[:2] in (["docker", "stop"], ["docker", "rename"], ["docker", "update"]):
                self.assertTrue(any(arg.startswith("entropydrop-space-dev-") for arg in c))
                self.assertFalse(any(arg in ("entropydrop-space-api", "entropydrop-space-worker") for arg in c))

    def test_git_failure_does_not_build_or_replace_services(self):
        self.sync.side_effect = RuntimeError("dirty checkout")
        with self.assertRaises(RuntimeError):
            deploy.remote_deploy("prod")
        self.assertEqual(self.commands, [])

    def test_repository_changes_during_build_stop_before_migration(self):
        self.verify.side_effect = [None, RuntimeError("concurrent checkout change")]
        with self.assertRaises(RuntimeError):
            deploy.remote_deploy("prod")
        self.assertFalse(any("alembic" in c or c[:2] == ["docker", "stop"] for c in self.commands))

    def test_restarted_worker_is_not_ready(self):
        self.inspect.side_effect = None
        self.inspect.return_value = {"Image": "sha256:new", "RestartCount": 1, "State": {"Running": True}}
        with self.assertRaisesRegex(RuntimeError, "restarted"):
            self.actual_wait("dev", "sha256:new", timeout=1, settle=0)


if __name__ == "__main__":
    unittest.main()
