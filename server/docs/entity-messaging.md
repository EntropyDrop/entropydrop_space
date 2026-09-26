# Entity messaging API

Messages are ephemeral. The sender uses an authenticated HTTP request and the
receiving entity maintains a WebSocket connection. The service does not queue
messages for offline entities.

## Send

```http
POST /space/api/v2/worlds/{world_id}/entities/{source_id}/messages/{target_id}
Authorization: Bearer <account credential>
Message-Type: chat
Content-Type: text/plain; charset=utf-8

hello
```

The authenticated account must be a member of the world and the execution
holder of an active source entity. `source_id` is in the path because the
current account credential identifies a user, not an entity.

`Message-Type` is 1–16 ASCII bytes and must match
`[a-z][a-z0-9._-]{0,15}`. `chat` is reserved and requires UTF-8. Other types
may use either supported body format:

- UTF-8 text: `Content-Type: text/plain; charset=utf-8`
- Protobuf bytes: `Content-Type: application/x-protobuf`

The body is the raw payload. The limit is 4096 bytes after UTF-8 encoding, or
the raw Protobuf byte length. The rolling rate limit is 20 valid sends per
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
message connection is allowed per target entity at a time.
