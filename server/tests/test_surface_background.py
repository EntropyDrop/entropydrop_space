import threading
import space_surface

def test_surface_manifest_warmup_starts_only_one_daemon(monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def fake_backfill():
        started.set()
        release.wait(timeout=2)

    monkeypatch.setattr(space_surface, "_generation_thread", None)
    monkeypatch.setattr(space_surface, "_run_surface_generation_until_current", fake_backfill)

    assert space_surface.ensure_surface_generation_started() is True
    assert started.wait(timeout=1)
    assert space_surface.ensure_surface_generation_started() is False

    release.set()
    space_surface._generation_thread.join(timeout=1)
    assert space_surface._generation_thread.is_alive() is False
