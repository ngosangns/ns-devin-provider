# ns-devin-core

Shared host-neutral core for Devin (Cognition Cascade): the Connect/protobuf
wire protocol, PKCE + API-key credentials, model discovery, and the
`DevinStreamEvent` streaming vocabulary. This package is a dependency of the
host adapter (`ns-dsh-llm-devin`) — it is not meant
to be installed or configured directly.

## What it does

- `streamDevin(request)` — one Cascade turn: `GetUserJwt` (session → user JWT +
  optional edge URL), `AssignModel` for router models, then `GetChatMessage`
  over Connect server-streaming framed protobuf (`application/connect+proto`,
  gzip envelopes, end-of-stream JSON trailers).
- `fetchDevinModels()` — `GetCliModelConfigs` under the pinned CLI identity,
  normalized onto `DevinModelSpec` with effort-lane collapse (`effortMap`).
- `resolveDevinCredentials()` / `saveDevinCredentials()` — the CLI credential
  store at `~/.local/share/devin/credentials.toml`, shared with `devin auth`.
- `loginDevinWithPkce()` — the CLI's browser PKCE flow against app.devin.ai.
- `fetchDevinUsage()` — plan tier, credit buckets, and daily/weekly quota
  windows from `SeatManagementService/GetUserStatus`.
- A hand-rolled protobuf runtime (`proto/protobuf.ts`) plus the vendored
  Cascade message surface (`proto/devin-messages.ts`).

## Upstream

The Cascade client is ported from oh-my-pi's built-in Devin provider
(`@oh-my-pi/pi-ai` `providers/devin.ts`, `@oh-my-pi/pi-catalog`
`discovery/devin.ts` + `wire/devin.ts`, MIT, https://github.com/can1357/oh-my-pi).
Last synced against 18.8.4: Fusion lead routing, the legacy Windsurf
Enterprise catalog fallback, the raw-key retry after a 401, and strict final
tool-argument parsing. Host-specific hooks (`onPayload`) and pure refactors are
not carried over.
