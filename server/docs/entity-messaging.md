# Entity messaging API

Messages are ephemeral. The sender uses an authenticated HTTP request. The
active execution runtime maintains the receiving WebSocket connection; entity
scripts read delivered messages through `ctx.messages`. The service does not
queue messages for offline entities.

## Send

Entity scripts send through `ctx.messages.send`; the runtime makes the
authenticated request outside QuickJS, so account credentials are not exposed
to script code:

```js
if (!self.state.chatSent) {
  const queued = ctx.messages.send(targetId, 'chat', 'hello');
  if (queued.ok) {
    self.state.chatSent = true;
    self.state.chatCommandId = queued.commandId;
  }
}

const result = self.state.chatCommandId
  ? ctx.commands.get(self.state.chatCommandId)
  : null;
if (result && (result.deliveryStatus || result.status === 'rejected')) {
  ctx.log(`Message ${result.deliveryStatus || result.reason || 'rejected'}`);
  self.state.chatCommandId = null;
}
```

`send(targetId, type, payload, encoding='utf8')` returns a queued command
result. Read `ctx.commands.get(commandId)` in a later frame for the routed or
dropped status and rejection reason. The `chat` type is reserved and requires
UTF-8. Protobuf sends pass an array of bytes and `'protobuf'` as the encoding.
Invalid arguments are rejected before queuing; backend rate limits and inactive
targets appear in the command result.

```http
POST /space/api/v2/worlds/{world_id}/entities/{source_id}/messages/{target_id}/chat/utf8
Authorization: Bearer <account credential>
Content-Type: application/octet-stream

hello
```

The authenticated account must be a member of the world and the execution
holder of an active source entity. `source_id` is in the path because the
current account credential identifies a user, not an entity.

The URL contains `target_id`, `message_type`, and `encoding`. `message_type`
is 1–16 ASCII bytes and must match `[a-z][a-z0-9._-]{0,15}`. `encoding` is
`utf8` or `protobuf`; the reserved `chat` type requires `utf8`.

The body is the raw payload with `Content-Type: application/octet-stream`.
The limit is 4096 bytes after UTF-8 encoding, or the raw Protobuf byte length.
The rolling rate limit is 20 valid sends per
second per source entity; requests over the limit are rejected with `429` and
`Retry-After`. Attempts to inactive targets count toward the limit.

An active target with a live message WebSocket receives a MessagePack binary
frame shaped like this:

```text
{
  type: "entity_message",
  message_id: string,
  source_id: string,
  target_id: string,
  message_type: string,
  encoding: "utf8" | "protobuf",
  payload: bytes
}
```

The response is `202` with `status: "routed"` when the frame was published to
the target's live connection. A missing, stopped, or disconnected target is
not queued; the request returns `200` with `status: "dropped"` and
`reason: "target_inactive"`. `routed` confirms backend routing, not application
processing by the recipient.

Other errors include `400` for invalid type or UTF-8, `401` for missing or
invalid credentials, `403` when the account is not the entity's execution
holder, `409` when the source is inactive, `413` for a payload over 4096 bytes,
`415` for an unsupported content type, and `503` when Redis routing is
unavailable.

## Receive

Entity scripts do not open a socket or request tickets themselves. Browser
execution and hosted execution connect the active entity runtime automatically.
The script's root component reads each delivered batch from `ctx.messages`:

```js
for (const message of ctx.messages) {
  if (message.type === 'chat' && message.encoding === 'utf8') {
    ctx.log(`${message.sourceId}: ${message.payload}`);
  }
}
```

Each entry is a frozen record with `messageId`, `sourceId`, `targetId`, `type`,
`encoding`, and `payload`. UTF-8 payloads are strings. Protobuf payloads are
frozen arrays of byte numbers (`0`–`255`). The batch belongs to one submitted
20 Hz script frame and is consumed when that frame is submitted. Messages are
not queued by the service while the target is inactive or disconnected.
Messages already received live only in runtime memory and Stop clears them. The
runtime inbox holds at most 64 messages and 256 KiB; it drops the oldest queued
entries if that bound is reached.

The following ticket/WebSocket protocol is the runtime's transport layer; game
scripts should use `ctx.messages` instead.

First request a short-lived, single-use ticket:

```http
POST /space/api/v2/worlds/{world_id}/entities/{entity_id}/message-ticket
Authorization: Bearer <account login credential>
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
message connection is allowed per target entity at a time. Hosted entities use
a worker-managed connection and cannot request a browser message ticket.
