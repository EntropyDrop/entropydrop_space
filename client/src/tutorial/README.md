# Tutorial level

Open the controls screen and choose **Tutorial** to open it in a new tab,
or add `?tutorial=1` to the game URL. This works in the online and offline builds
without account admission or server APIs.

The base world is a torus with a constant ground height (top surface at Y=17),
generated in the browser by terrain generator version 9. Gray and off-white
blocks alternate in a one-block checkerboard across the ground. No terrain decorations
or hills are generated. Only the fixed 25 by 25 chunk square centered on the
saved spawn's chunk is rendered (12 chunks in each direction, 625 total). The
window does not follow the player, and distant terrain is always disabled.
Terrain-distance settings from other worlds do not change the tutorial window.

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
terrain, backpacks, account information and network queues. The checked-in empty
file provides a blank authoring world.

Every entry creates fresh in-memory terrain/entity storage from the bundled
file. Edits made while playing are temporary, including entity changes, unless
explicitly saved in the local authoring session.
Backpacks use the same persistent browser storage as other worlds on the same
origin and are never included in a lesson.

Market, publishing, hosting, multiplayer, linked worlds, external agents, AI
services and account features show tutorial guidance instead of contacting their
services. Local entity editing, compilation and execution remain available.
