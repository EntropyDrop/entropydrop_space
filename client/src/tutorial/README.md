# Tutorial level

Open the controls screen and choose **Tutorial** to open it in a new tab,
or add `?tutorial=1` to the game URL. This works in the online and offline builds
without account admission or server APIs.

The base world is a torus with a constant ground height (top surface at Y=17),
generated in the browser by terrain generator version 9. Gray and off-white
blocks alternate in a one-block checkerboard across the ground. No terrain decorations
or hills are generated. The fixed 25 by 25 chunk square is centered 128 m ahead
of the saved spawn, along its heading (12 chunks in each direction, 625 total).
This covers the entire straight course, the driving lane and the Modeling station. The
window does not follow the player, and distant terrain is always disabled.
Terrain-distance settings from other worlds do not change the tutorial window.

Chapter signs follow roughly 20 m intervals along the initial heading. Chapter 11
has extra space on each side for `self.setSpinYAxisRPM(30)` to appear on
one line: its sign and practice stand move about 5 m farther along the course,
and chapters 12–13, their guides, the driving lane and finish move about 10 m.
Chapter 03 teaches double-tapping Space to toggle flight; chapter 04 teaches
Space to rise and Shift to descend. Landing exits flight.
Run `node client/tools/refresh-tutorial-signs.mjs`
from the repository root to rebuild the clear pixel lettering and spoked wheel. The wheel,
motor stand, chassis guides, and driving lane continue beyond chapter 09.
Signs ask players to check STANDARD/MICRO instead of blindly toggling Tab at
every chapter. Tab switches modes when the displayed mode is different.
From chapter 08 onward, selection exercises use MICRO mode. Colored corner
microcells identify the selection endpoints without additional HUD labels.
A new click after a completed selection immediately starts the next selection. The horizontal
rotation cylinder and its two corner markers use individual microcells. Run
`node client/tools/refresh-tutorial-micro-practice.mjs` to rebuild it and the
vehicle-sized module assembly guide.
Chapter 09's airborne subject is a double-cab off-road pickup without wheels:
it has a low hood, four doors, large tinted windows, an open ribbed cargo bed,
sport bar, lights, recovery bumpers, running boards and interior seats. Four
flared wheel arches and recessed axle mounting pads remain for the chapter 10
wheels. A single blue microcell is embedded in the front bumper; a single green
microcell floats at the opposite upper rear corner without a supporting post.
Chapter 09 uses a micro-grid box between these opposite corners to select every
vehicle voxel. The floating green microcell is included in the assembled entity.
The body is 9 m long, 4.25 m wide and 3.125 m high, proportioned around the
2 m diameter lesson wheel; the wheelbase is 6 m. Tires sit beneath the flared
arches, with their complete rotating envelope clear of the bodywork.
Run `node client/tools/refresh-tutorial-chassis.mjs` from the repository root
to rebuild this subject without changing the obstacle underneath or other lessons.
The micro-voxel wheel lies flat on the ground and is selected with the default
Y-axis cylinder. It has an unbroken tire and eight spokes on its lower face;
the upper half has an open recessed barrel, so the two faces are distinguishable.
Its script uses `self.setSpinYAxisRPM(30)` to spin around local Y. Aim the
Hammer at an axle face: surface alignment already turns the wheel upright.
From the default Hammer pose, press Up twice to put the hollow face toward the
body. Repeat this alignment when attaching the first wheel and then the other three.
Reverse RPM on the opposite side in the editor so all four drive forward.
From chapter 09 onward, Stop is taught as Wrench (`3`) plus double left-click.
Chapter 11 returns from the editor with Escape before stopping the wheel;
chapter 13 also starts the car with a Wrench double-click.
The tutorial editor's Agent panel explains that the code teaches
how entities work. In the full game, players can usually describe their intent
to the Agent in natural language instead of writing code manually. Agent
requests remain unavailable inside the tutorial.
Kinematic wheel scripts drive the dynamic chassis through terrain contact
friction; the chassis needs no thrust script. Keep wheel collision enabled,
use a nonzero wheel friction, and point the car along the lane before starting.

Chapter 14 continues straight beyond the driving lane with one stopped, kinematic
work pad. Its empty half is for practice; the other half shows a finished sloping
panel. Press `7`, aim at the empty gray pad, then hold and drag RMB and release
to create a panel. Creation selects it automatically; LMB selects it again later. Escape releases the cursor
for the right properties panel: set Dimensions X/Y/Z to `4`, `0.25`, `3` and
Rotation Z to `-30`. Lift it with the Y arrow to clear the base. Modeling produces
visual decorations without collision; the example is not a drivable ramp.
Run `node client/tools/refresh-tutorial-modeling.mjs` to rebuild this work pad.
The finish sign is after this chapter. The fixed terrain window shifts one chunk
forward to cover it while retaining the same 625 chunks and disabled distant terrain.

Run `npm run dev` and open the tutorial on `localhost`, `127.0.0.1` or `[::1]`.
Build the lesson with the normal tools, then click **Save Level** at the top
right. This directly overwrites `client/src/tutorial/tutorial-level.json` through
the local Vite development server. Saving does not reload the current session;
the next entry loads the saved lesson. Rebuild and deploy to publish the change.
Published builds (including offline distributions) have no save button or writer.
Every entry uses the fixed position and heading in the level file's `spawn`,
with a horizontal view. Save Level updates terrain and entities while preserving
that spawn. Moving or looking around while editing does not change the next entry.

The main site's local Vite server also supports saving when it mounts Space.
Register `devTutorialLevel({ root: spaceClientRoot })` in that server's plugins;
the endpoint follows the host's Vite base URL while the destination stays in
the Space project. Keep this plugin development-only and retain its same-origin
loopback checks.

The file contains generator metadata, spawn, sparse standard/micro voxel edits
(including AIR tombstones for removed ground), and all active and dormant
entities, including their scripts and component hierarchy. It excludes generated
terrain, backpacks, account information and network queues. The checked-in file
contains the authored course and the Modeling work pad.

Every entry creates fresh in-memory terrain/entity storage from the bundled
file. Edits made while playing are temporary, including entity changes, unless
explicitly saved in the local authoring session.
Backpacks use the same persistent browser storage as other worlds on the same
origin and are never included in a lesson.

Market, publishing, hosting, multiplayer, linked worlds, external agents, AI
services and account features show tutorial guidance instead of contacting their
services. Local entity editing, compilation and execution remain available.
