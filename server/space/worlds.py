"""Stable world selectors shared by browser bootstrap and external agents."""
from dataclasses import dataclass

from config import settings


@dataclass(frozen=True)
class WorldSpec:
    slug: str
    id: str
    name: str
    seed: int
    terrain_generator_version: int
    is_default: bool = False


def configured_worlds(*, include_unavailable=False) -> tuple[WorldSpec, ...]:
    default = WorldSpec("nature", settings.SPACE_DEFAULT_WORLD_ID, "Nature",
                        settings.SPACE_WORLD_SEED, 1, True)
    worlds = (default, *(
        WorldSpec(slug, getattr(settings, f"SPACE_{key}_WORLD_ID"), name,
                  getattr(settings, f"SPACE_{key}_WORLD_SEED"), version)
        for slug, key, name, version in (
            ("copper-metropolis", "COPPER_METROPOLIS", "Copper Metropolis", 2),
            ("aether-archipelago", "AETHER_ARCHIPELAGO", "Aether Archipelago", 3),
            ("colossus-harbor", "COLOSSUS_HARBOR", "Colossus Harbor", 4),
            ("titan-canyon", "TITAN_CANYON", "Titan Canyon", 5),
            ("astral-foundry", "ASTRAL_FOUNDRY", "Astral Foundry", 6),
            ("brutalist-dusk", "BRUTALIST_DUSK", "Brutalist Dusk", 7),
            ("mixed", "MIXED", "Mixed", 8),
        )
    ))
    if not include_unavailable and settings.ENVIRONMENT.lower() not in {"dev", "development", "test", "testing"}:
        # The public landing page offers Nature and Copper. Keep experimental
        # terrain-lab worlds restricted without rejecting the published Copper entry.
        return tuple(world for world in worlds if world.slug in {"nature", "copper-metropolis"})
    return worlds


def find_world_spec(selector: str | None, *, include_unavailable=False) -> WorldSpec | None:
    requested = (selector or "nature").strip().lower()
    if requested in {"", "default"}:
        requested = "nature"
    return next((world for world in configured_worlds(include_unavailable=include_unavailable)
                 if requested in {world.slug, world.id.lower()}), None)


def world_identity(world_id: str) -> dict:
    spec = find_world_spec(world_id, include_unavailable=True)
    return {"slug": spec.slug if spec else None, "is_default": bool(spec and spec.is_default)}


def world_display_name(world) -> str:
    if str(world.id) == settings.SPACE_DEFAULT_WORLD_ID and world.name == "EntropyDrop Space":
        return "Nature"
    return world.name
