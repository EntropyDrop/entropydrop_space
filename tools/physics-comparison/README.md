# Space and Rapier physics comparison

Measured on 2026-11-21 on Apple M1 Pro, using Space at `9f15918`, Node 24.22.1,
headless Chrome 158.0.8127.37, Rapier WASM 0.21.0 and native Rapier 0.36.0.
The current Space path uses its production geometry and solver WASM kernels.
The Rapier prototypes keep rigid bodies, joints and colliders resident between
updates. [Rapier WASM package](https://www.npmjs.com/package/@dimforge/rapier3d-compat/v/0.21.0) · [Rapier Rust crate](https://docs.rs/rapier3d/0.36.0/rapier3d/)

## Results

Each cell shows p50 / p95 in milliseconds, with three 60 Hz physics substeps and
a readout of the position, orientation and velocity of every rigid body per
50 ms update.

| Workload | Chrome Space | Chrome Rapier WASM | Node Space | Node Rapier WASM | Native Rapier |
| --- | ---: | ---: | ---: | ---: | ---: |
| 63 moving hinges with angular limits | 2.105 / 2.400 | 0.465 / 0.540 | 2.279 / 2.716 | 0.494 / 0.601 | 0.396 / 0.421 |
| 16 cubes in four stacks | 2.845 / 3.395 | 0.110 / 0.130 | 3.759 / 5.202 | 0.118 / 0.148 | 0.029 / 0.032 |
| 16 cubes on microvoxel pads | 0.965 / 1.210 | 0.110 / 0.125 | 1.111 / 1.499 | 0.117 / 0.151 | 0.028 / 0.034 |
| Remove one pad and run the first update | 0.995 / 1.675 | 0.175 / 0.255 | 1.149 / 1.540 | 0.217 / 0.272 | 0.030 / 0.051 |

Chrome and Node process the same 64 microvoxel deletions in both backends.
Space reads live collision geometry in this headless harness. The WASM prototype
queries the edited area and removes its resident pad collider. The native
prototype receives the collider removal directly, so its edit timing starts
after the microvoxel work. The floor uses standard voxel storage in Space and
one geometrically equivalent box in Rapier.

The timed Space path runs through `ContraptionManager.update` with its normal
host bookkeeping. The prototype runs the Rapier step and pose readout. The
timing scope covers headless simulation with fixed fixtures. Measuring production
gains would require app rendering, representative scripts, player carriage,
streamed terrain and network synchronization in the same test.

There are 24 measured rounds, with 12 timed updates per round, after six
discarded rounds. Each round constructs a fresh equivalent scene and runs six
untimed updates. The edit row has one sample per round. Space and Rapier WASM
alternate order. Construction and WASM loading occur outside the timers. The
browser uses a cross-origin isolated page for timing. The active windows in
these runs are short enough to measure active bodies and Rapier sleep is
disabled.

## Behavior and desktop transport

- Both prototypes kept sampled hinge anchor separation to about 1 micrometer
  and reached the 0.3 radian hinge limit.
- The lowest cube bottom remained at or above 0.999689 m on the 1 m floor
  across the sampled stack trajectory. The lowest final top-cube center was
  4.497000 m in Space and 4.496760 m in Rapier.
- Removing one 0.125 m support dropped its cube by 0.123 m in Space and 0.125 m
  in Rapier. The other cubes stayed in place at the reported precision.

The desktop transport measurement sent the stack fixture through the existing
`native-space/tools/runtime-worker.ts` over its line-delimited JSON protocol.
A snapshot-only round trip took 0.192 / 0.552 ms. A round trip advancing 50 ms
of simulation took 10.994 / 11.888 ms, with an average reply of 9,554 bytes.
The current adapter sends this work through three manager updates of 1/60 s
for a total of nine physics substeps. The desktop measurement uses a Node
requester and includes worker-side pose assembly, JSON encoding and decoding
and pipe transfer. Its cadence and output differ from the direct comparison.

A resident Rapier prototype on the actual desktop vehicle path is a useful
next comparison. It should include terrain collider updates, contact
publication, moving-platform behavior and coordinate wrapping, with the
current runtime as the reference.

## Reproduce

Install the repository's normal Node dependencies first. From the repository
root, with Node 24 or later and a Rust toolchain on `PATH`:

```sh
npm ci --prefix tools/physics-comparison --ignore-scripts
rapier_bench_target="$(mktemp -d)"
cargo build --release --locked --manifest-path tools/physics-comparison/native/Cargo.toml \
  --target-dir "$rapier_bench_target"
node --import ./engine/test/setup.ts tools/physics-comparison/run.mjs \
  --native "$rapier_bench_target/release/space-physics-comparison" \
  --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --bridge \
  --output "$rapier_bench_target/results.json"
```

The default invocation measures Node. The browser, native binary and desktop
pipe measurements are enabled by their corresponding flags. Change the Chrome
path for your installation. The output JSON retains per-update timings and
sampled poses.
