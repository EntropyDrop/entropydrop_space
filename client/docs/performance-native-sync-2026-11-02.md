# Native interaction, local LOD restore and scheduling, 2026-11-02

This work ports the interaction and loading behavior from Web commit `023a325`
to the offline native client. It builds on the pending native frame-submission
work documented in [the frameflow report](performance-frameflow-2026-11-02.md).
Metal shaders, Ultra effects, native resolution, 4x MSAA, 4096px shadows, the
1 GiB LOD source budget and 512 MiB / 48 face budget are unchanged.

## Behavior

- G assembles the current terrain selection in place into a stopped, kinematic
  entity, without opening the editor or changing the clipboard/backpack.
  Terrain removal and entity creation share one undo/redo entry, including
  micro voxels. C opens the entity under the crosshair; a miss does not open a
  previously selected entity.
- New assemblies use automatic mass, disabled gravity, enabled collisions,
  restitution 0.1 and friction 0.7. Switching to Dynamic enables gravity;
  reselecting Dynamic preserves explicitly disabled gravity. The inspector
  does not accidentally replace automatic mass or omitted properties when
  another field changes. Existing imported entities preserve authored settings.
- The native runtime already uses the shared engine. Integration tests confirm
  that deliberate script type changes enable gravity and Stop restores authored
  defaults. Native carrying only changes the stopped entity transform, retaining
  its body definition.
- Optional coarse coverage is persisted beside existing source caches. Its index
  is scoped to world, seed, generator and terrain source hash. Every restored
  entry checks a compressed SHA-256 digest, bounded decompression and mip layout.
  Partial refinement merges into the last-good index. Edited zones skip base
  coverage; corrupt/missing entries are misses. This is a local cache, with no
  network revalidation or dependence on Web authentication/storage.
- Coverage uses a separate temporary planner. Full refinement retains the old
  source order and hysteresis history. Adapter failures retain the last GPU
  geometry and retry; worker restarts skip overview publication to avoid replacing
  already refined geometry with coarse coverage.

The Web tutorial course, tutorial nameplates and browser-specific UI have not
been ported; the native client still has the gaps listed in its migration guide.

## Scheduling and CPU work

The former application requested at most one fine source every 500 ms, imposing
roughly a 64-second pacing floor for 128 zones. Native now requests the next
source immediately after publishing the previous batch until refinement finishes.
Afterward it retains the 500 ms view-update cadence and suppresses requests for
unchanged camera, height, projection and world revision. Failed requests back off.

Near chunk demand keeps the same circular radius, torus wrapping and distance
priority, but reuses the ordered keys until the center chunk or radius changes.
Completed demand no longer repeats all chunk lookups each frame. Incomplete
requests remain eligible for retry. Packed LOD IPC writes four words per face
through a typed view and copies visibility floats in bulk; the ABI is unchanged.
Decompressed mip arrays own their bytes, so dropping fine mips does not retain a
complete source through a Buffer slice.

## Real-world geometry and IPC comparison

`node native-space/tools/benchmark-lod.ts` prewarms caches, then runs legacy,
candidate, candidate, legacy. All 128 Aether sources are fully refined before
comparison, followed by identical camera movements. The benchmark hashes every
final tile's bytes, bounds, origin and face count, including empty tiles.

All four settled hashes match, as do all four moving hashes. Each settled run
contains **11,184,540 distant faces** and **1,073,738,464 source bytes**. The
measurement height is 2178px. Raw data: [LOD comparison](../src/dev/results/native-sync-2026-11-02/lod-loading.json).

| Metric | Legacy runs | Candidate runs |
|---|---:|---:|
| Full refinement, no application pacing | 20.85 / 20.80 s | 21.00 / 21.17 s |
| Accumulated packing and tile-file writes | 2.268 / 2.182 s | 1.362 / 1.356 s |
| One unchanged-view request | 43.72 / 42.97 ms | 0.524 / 0.439 ms |
| First response, covered / refined zones | 1 / 1 | 128 / 0 |

Packing/file-write time falls about **39%**, and unchanged-view request CPU time
falls about **99%**. Total unpaced refinement time does not improve: it also
includes overview recovery, decoding, planning and validation. These numbers
are CPU/IPC measurements, not GPU time or application FPS. The retained change
in application loading speed is chiefly the removal of unnecessary pacing.

## Actual moving window

Apple M1 Pro, 1908x2018, Ultra 100%, VSync disabled for diagnosis. The normal
streaming, physics, sky animation, UI layout and presentation remain active.
After full refinement and a 24-second moving warm-up, eight candidate/reference
blocks are interleaved with eight identical-code control blocks. Each block
excludes two seconds and samples four seconds. All sampled blocks remained
focused, unoccluded and at the same size, with no concurrent builds or tests.

| Metric | Reference | Candidate |
|---|---:|---:|
| Aggregate completed-frame rate | 119.99 FPS | 120.44 FPS |
| Mean frame interval | 8.334 ms | 8.303 ms |
| Mean of block medians, pre-render CPU | 0.209 ms | 0.192 ms |
| Identical-code control frame rate | 119.83 FPS | 120.01 FPS |

The main-thread CPU phase falls approximately **8%**, about **0.017 ms**. The
frame-rate difference is only **0.37%**, with **0.15%** label variation in the
identical-code control, and cadence stays close to 120 FPS. This does **not**
establish a stable frame-rate gain. GPU rendering work is unchanged. The benchmark
compares native main-thread scheduling; both modes use the new IPC adapter.
The window records render/present completions, not unique display scanouts.

[Window summary](../src/dev/results/native-sync-2026-11-02/window-streaming.json)
and [raw samples](../src/dev/results/native-sync-2026-11-02/window-streaming.json.gz)
retain the per-block timings and controls. Its binary predates only the final
shortcut labels and fixed-size startup-diagnostic window option.

## Fixed-window loading

The retained loading comparison uses 2560x1440, the same saved world with edits
in two zones, warm disk caches, the same fixed camera, and all Ultra effects.
Both runs retain **11,271,128 resident faces**, 149 near chunks, the same
29.06 effective area and 29 source-limited zones when fully refined. Both
record one constant size and zero occluded frames. The new loader restores
126 unedited zones and regenerates the two edited zones before complete coverage.

| Milestone, including application/window initialization | Legacy | Candidate |
|---|---:|---:|
| All 128 zones covered and uploaded | 70.86 s | 7.78 s |
| Full refinement and near uploads complete | 70.86 s | 29.01 s |

Full refinement finishes approximately **59% sooner** (about **2.44x** faster).
The candidate's first milestone includes coarse coverage and must not be used
as the equivalent-quality speedup. This is a loading-time result, not an FPS
or GPU-throughput result. Unlike the moving benchmark above, the fixed-size
startup windows reported `focused=false` despite being kept visible; both logs
retain their unfocused-frame counts. These observations are therefore not claimed
as a focus-controlled rendering comparison. Unpaced CPU results above establish
that the main loading benefit is the removed 500 ms application delay.

[Reference](../src/dev/results/native-sync-2026-11-02/startup-reference.json)
and [candidate](../src/dev/results/native-sync-2026-11-02/startup-candidate.json)
contain the full milestones, geometry counts and window-state records.
The initial reference used a different size; one candidate changed size and
became occluded, and a subsequent reference was also occluded. Those records
are retained with `initial`/`excluded`/`occluded` names and are excluded from
the table. Tests do not write player saves.

## Validation and reproduction

Native format checks, Clippy, 35 Rust tests, strict adapter TypeScript checking
and nine Node tests pass. Forty targeted shared-engine/Web tests also pass.
Coverage includes cache isolation/corruption/failure, saved-edit exclusion,
complete-index retention, legacy/final/moving geometry equivalence, packed integer
ranges and visibility boundaries, assembly undo/redo, body transitions and
native runtime Start/Stop. Player save SHA-256 remains unchanged. Documentation
links pass. The repository-wide English check still reports 274 pre-existing
non-English lines in native README/RENDERING/MIGRATION; no new non-English
content was added.

```sh
sh native-space/tools/check.sh
sh native-space/tools/bundle.sh
node native-space/tools/benchmark-lod.ts
SPACE_NATIVE_LEGACY_LOD=1 SPACE_NATIVE_LEGACY_STREAMING=1 \
  native-space/target/release/space-native --profile-window-startup
native-space/target/release/space-native --profile-window-startup
native-space/target/release/space-native --profile-window-streaming
```

Keep the actual-window tests focused and unoccluded. They are ephemeral and
never write the player's save. Startup reports coverage and full refinement
separately. All final performance samples must wait for `refined 128/128`;
restored coarse coverage alone is not an equivalent workload.
