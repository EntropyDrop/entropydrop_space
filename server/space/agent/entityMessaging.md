# Entity messaging API

[spaceAPI](spaceAPI.md) · [entityAPI](entityAPI.md)

Messages are ephemeral and best effort. The sender uses an authenticated HTTP request. The
active execution runtime maintains the receiving WebSocket connection; entity
scripts read delivered messages through `ctx.messages.received`. The service does not
queue messages for offline entities.

The protocol requires an `Idempotency-Key` and provides at-most-once submission
for that operation within the five-minute de-duplication window. It does not
guarantee ordering across requests or senders, does not persist messages, and
has no recipient acknowledgement. `routed` means the message was published to
the target's current execution connection; it does not mean the target script
processed it.

## Versioning and compatibility

The send and ticket resources are part of Space API v2. The receiving socket
requires the `space-entity-messages-v1` subprotocol. Implementations must ignore
unknown response and MessagePack fields so compatible optional fields can be
added. A wire-format or semantic breaking change requires a new API resource or
WebSocket subprotocol.

Application Protobuf schemas are outside the transport protocol. Their
`message_type` carries the application schema version, such as `radar.v1`; a
breaking application schema change uses a new suffix.

## Send

Entity scripts send through `ctx.messages.send`; the runtime makes the
authenticated request outside AssemblyScript/WASM, so account credentials are not exposed
to script code:

```ts
const targetId = "20000000-0000-4000-8000-000000000000";
if (!self.state.getBoolean("chatSent")) {
  const queued = ctx.messages.send(targetId, "chat", "hello");
  if (queued.getBoolean("ok")) {
    self.state.setBoolean("chatSent", true);
    self.state.setString("chatCommandId", queued.getString("commandId"));
  }
}
const result = ctx.commands.result(self.state.getString("chatCommandId"));
if (!result.isNull) {
  ctx.log(result.getString("deliveryStatus", result.getString("reason")));
}
```

`send(targetId, type, payload: string)` returns a queued command
result. Read `ctx.commands.result(commandId)` in a later frame for the routed or
dropped status and rejection reason. The `chat` type is reserved and requires
UTF-8. Protobuf sends use `ctx.messages.sendBytes(targetId, type, bytes: Uint8Array)`.
Invalid arguments are rejected before queuing; backend rate limits and inactive
targets appear in the command result.

```http
POST /space/api/v2/worlds/{world_id}/entities/{source_id}/messages/{target_id}/chat/utf8
Authorization: Bearer <account credential>
Content-Type: application/octet-stream
Entity-Execution-Instance: <current browser execution instance UUID>
Entity-Execution-Epoch: <current positive execution epoch>
Idempotency-Key: <required; 1-80 ASCII letters, digits, dot, underscore, colon or hyphen>

hello
```

The authenticated account must be a member of the world. The instance UUID and
epoch must identify the exact browser execution lease currently held by that
account for the active source entity. The server verifies this identity before
and after reading the body. Hosted execution uses the same validation and
routing core through its trusted worker identity. Entity scripts do not set
these headers themselves.

The URL contains `target_id`, `message_type`, and `encoding`. `message_type`
is 1–16 ASCII bytes and must match `[a-z][a-z0-9._-]{0,15}`. `encoding` is
`utf8` or `protobuf`; the reserved `chat` type requires `utf8`. A Protobuf type
must identify its schema version with a positive `.vN` suffix, for example
`radar.v1`.

The body is the raw payload with `Content-Type: application/octet-stream`.
The limit is 4096 bytes after UTF-8 encoding, or the raw Protobuf byte length.
The rolling rate limit is 20 valid sends per
second per source entity; requests over the limit are rejected with `429` and
`Retry-After`. Attempts to inactive targets count toward the limit. Replays of
a completed `Idempotency-Key` return the original result without consuming the
rate limit. Reusing a key with different target, type, encoding or payload is
rejected with `409`. Keys are scoped to the world and source entity. Concurrent
use of an operation that is still in progress returns `409` with
`Retry-After`; a completed replay returns the original HTTP result and
`message_id`. After five minutes the same key represents a new operation.

An active target with a live message WebSocket receives a MessagePack binary
frame shaped like this:

```text
{
  type: "entity_message",
  message_id: string,
  source_id: string,
  target_id: string,
  target_execution_epoch: integer,
  message_type: string,
  encoding: "utf8" | "protobuf",
  payload: bytes
}
```

The response is `202` with `status: "routed"` when the frame was published to
the target's live connection. A missing, stopped, or disconnected target is
not queued; the request returns `200` with `status: "dropped"` and
`reason: "target_inactive"`.

Other errors include `400` for invalid type or UTF-8, `401` for missing or
invalid credentials, `403` when the account is not the entity's execution
holder, `409` when the source lease or idempotency state is invalid, `413` for
a payload over 4096 bytes, `415` unless the body uses
`application/octet-stream`, and `503` when Redis routing is unavailable.

## Player block clicks

Game clients send a crosshair left-click hit through:

```text
POST /space/api/v2/worlds/{world_id}/entities/{target_id}/clicked-block
Authorization: Bearer <account token>
Content-Type: application/json
Idempotency-Key: <eventId>
Entity-Target-Execution-Epoch: <target epoch observed at click time>
```

The JSON body is `{eventId,nodeId,kind,position,size,decorationId,point,localPoint}`.
`kind` is `standard`, `micro`, or `decoration`; `size` is respectively `1`,
`0.125`, or `null`. Decorations require their `decorationId`; voxels use `null`.
The three vectors contain finite coordinates in metres. `position` is the voxel
minimum corner or decoration center in authored component coordinates; `point`
is the flat world hit and `localPoint` is that hit in authored component coordinates.
The service stamps `entityId` from the URL and `playerId` from authentication,
ignoring any submitted identities. World membership is required; a player does
not need to own or execute an entity to click it. The service bounds and validates
the reported input; it does not verify block existence, reach, or line of sight
against server geometry. A click is interaction input, not proof of authorization;
scripts must enforce access rules for protected actions. Identifier limits are
measured in UTF-16 code units, matching the JavaScript runtime (64 for `eventId`,
128 for `nodeId` and `decorationId`).

The 4 KiB request limit, five-minute idempotency rules, routed/dropped responses,
and execution-epoch fencing also apply. The rate limit is 20 clicks per second
per player in a world. Clicks are ephemeral and dropped for inactive receivers.
The target epoch header is required and must be a positive safe integer. A
missing or invalid epoch returns `400` (`ENTITY_CLICK_EXECUTION_EPOCH_INVALID`).
The server compares the supplied epoch with the active target epoch; a mismatch
returns `200`, `status: "dropped"`, `reason: "target_epoch_changed"`. It never
upgrades a delayed click to a restarted execution. Idempotency includes the epoch;
reusing an event ID with a different epoch returns `409`. The epoch is transport
metadata and does not change the `ctx.clickedBlock` record.
The receiver sees an `entity_message` envelope with `message_type: "clicked_block"`,
`encoding: "utf8"`, and the trusted native marker `clicked_block: true`.
Its payload contains the normalized JSON record. Only this player endpoint can
set the marker; a script-authored message with the same type stays an ordinary message.

The runtime exposes native input as the immutable nullable `ctx.clickedBlock`
to every enabled component, at most one click per submitted frame, instead of
adding it to `ctx.messages.received`. Clicks have an independent 64-entry queue;
overflow drops the oldest click. Messages have a separate capacity and frame
budget, so clicks cannot block or evict messages, and messages cannot evict clicks.
The runtime deduplicates the latest 256 `(playerId, eventId)` pairs per entity
execution, allowing different players to use the same event ID. Stop clears
queued clicks and deduplication, and checkpoints do not persist them. The entityAPI
reference linked above describes SDK fields and an example.

The hosted runtime acknowledges original inbox indices, including rejected or
duplicate entries, instead of a consumed-prefix count. The worker validates these
indices before committing the simulation and removes only the acknowledged
entries after a successful commit; a failed commit retains the batch for retry.

## Receive

Entity scripts do not open a socket or request tickets themselves. Browser
execution and hosted execution connect the active entity runtime automatically.
The script's root component reads each delivered batch from
`ctx.messages.received`:

```ts
for (let i = 0; i < ctx.messages.received.length; i++) {
  const message = ctx.messages.received.at(i);
  if (message.getString("type") == "chat" && message.getString("encoding") == "utf8") {
    ctx.log(message.getString("sourceId") + ": " + message.getString("payload"));
  }
}
```

`ctx.messages` is a typed Messages handle exposing `received`, `send` and `sendBytes`. Records are read through Value typed accessors. Each
received entry is a frozen record with `messageId`, `sourceId`, `targetId`, `type`,
`encoding`, and `payload`. UTF-8 payloads are strings. Protobuf payloads are
frozen arrays of byte numbers (`0`–`255`). The batch belongs to one submitted
20 Hz script frame and is consumed when that frame is submitted. Messages are
not queued by the service while the target is inactive or disconnected.
Messages already received live only in runtime memory and Stop clears them. The
runtime inbox holds at most 64 messages and 256 KiB; it drops the oldest queued
entries if that bound is reached. One submitted script frame exposes at most 8
messages and 16 KiB. Remaining messages stay in the runtime inbox for later
frames, preventing a valid burst from consuming the component's execution
budget.

The following ticket/WebSocket protocol is the runtime's transport layer; game
scripts should use `ctx.messages.received` and `ctx.messages.send` instead.

First request a short-lived, single-use ticket:

```http
POST /space/api/v2/worlds/{world_id}/entities/{entity_id}/message-ticket
Authorization: Bearer <account login credential>
Entity-Execution-Instance: <current browser execution instance UUID>
Entity-Execution-Epoch: <current positive execution epoch>
```

The active entity's execution holder receives a ticket and the WebSocket URL.
Connect using the `space-entity-messages-v1` subprotocol, then send a binary
MessagePack hello frame:

```text
{ type: "hello", ticket: string }
```

The server replies with a `ready` frame. Clients may send `{type: "ping"}` to
keep the connection alive; the server replies `{type: "pong"}`. The receiver
must reconnect and request a fresh ticket after disconnecting. Only one live
message connection is allowed per target execution epoch at a time. Channels
are epoch-fenced, so a superseded execution connection cannot receive messages
for its replacement. Hosted entities use a worker-managed connection and
cannot request a browser message ticket.
