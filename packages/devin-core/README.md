# ns-devin-core

Shared host-neutral core for Devin (Cognition Cascade): the Connect/protobuf
wire protocol, PKCE + API-key credentials, model discovery, and the
`DevinStreamEvent` streaming vocabulary. This package is a dependency of the
host adapters (`ns-dsh-llm-devin`, `ns-omp-provider-devin`) — it is not meant
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
