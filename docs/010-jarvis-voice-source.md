# 010 Jarvis Voice Source

This document is the operator guide for the Jarvis source: the Source that turns one completed Voice turn into one Trigger, and speaks the answer back through the DSH bridge. The terms are defined in [GLOSSARY.md](../GLOSSARY.md); the design and its accepted trade-offs are in [ADR 0003](adr/0003-jarvis-voice-source.md). The source itself is the `dsh-source` package in the Jarvis repository; this repository only loads it and never contains its code.

The bridge protocol is pinned at **version 1**, path `/v1/dsh-bridge`. Upgrade the Jarvis service and the plugin together; a version mismatch is reported as `Incompatible bridge protocol` and no turn is accepted.

## 1. Prerequisites

- A working dsh-superagent instance on the `superagent` profile, with its panel reachable. See [006 Deployment](006-deployment.md) for the Docker and host-profile paths.
- A Jarvis checkout containing `dsh-source/` and `service/`. Node.js 22.18 or newer is needed to run the plugin's TypeScript sources without a build step.
- The Jarvis service reachable from the host that runs DeepSeek Harness, and its speech service configured (`AUDIO_URL`).
- The DSH launch token shared by both sides. The plugin reads it from a file, the Jarvis service mounts or reads the same file.

## 2. Install the plugin

Run these commands on the host that runs the profile, once per Jarvis checkout:

```sh
dsh plugin --profile superagent add "link:/path/to/jarvis/dsh-source"
```

Then add the plugin to `~/.dsh/profiles/superagent/cordis.patch.yml`, inside the existing top-level list:

```yaml
- insert:
    - id: dsh-superagent-jarvis-source
      name: jarvis-dsh-source
```

Restart the instance with `scripts/dsh-superagent restart` (add `--legacy` when using the host-profile path). The restart is required: the plugin is discovered at boot, not when the panel opens. Do not edit dsh-superagent's own source files.

The panel lists the plugin's Source kind `jarvis` under **Settings → Sources** after the restart.

## 3. Configure the Source

Create one `jarvis` Source instance. Exactly one instance may be enabled; a second one is refused by the registry. The config is re-read while the source runs, so edits apply without a restart.

| Key | Required | Meaning |
| --- | --- | --- |
| `url` | yes | Bridge address, for example `ws://127.0.0.1:8787`. The `/v1/dsh-bridge` path is appended when it is missing. |
| `deviceId` | yes | The one admitted device id (lowercase `[a-z0-9][a-z0-9._-]{0,63}`). Turns and replies for any other device are ignored. |
| `enabled` | no | `true` by default. `false` stops the client, reports `paused`, and keeps the kind installed. |
| `tokenFile` | no | File holding the launch token. Defaults to `service/auth/dsh-launch-token` relative to the Jarvis service working directory. |
| `legacyDirectSession` | no | Advanced rollback switch, `false` by default. See section 6. |

The token is resolved at every connection attempt from `JARVIS_DSH_BRIDGE_TOKEN`, then `tokenFile`, then `JARVIS_DSH_BRIDGE_TOKEN_FILE`, then `service/auth/dsh-launch-token`. If none can be read, the `bridge` entry reports an error naming the expected path; writing the file is enough to recover.

## 4. Configure the Jarvis service

Set these variables in the Jarvis `.env` (Compose passes them through) and restart it with `docker compose up -d`:

| Variable | Value | Meaning |
| --- | --- | --- |
| `JARVIS_DSH_BRIDGE` | `1` | Enables the bridge route. Without it the route answers `404` and the Source never connects. |
| `JARVIS_DSH_BRIDGE_DEVICE` | the same value as `deviceId` | The one admitted device. A mismatch is refused at handshake time. |
| `DSH_URL` | the dsh-superagent base URL | Already required by the Jarvis service. |
| `JARVIS_LEGACY_DSH_SESSION` | `1` only for rollback | Enables the old direct Session client. Leave unset in normal operation. |

Save the launch token as `service/auth/dsh-launch-token` with mode `600`. The client authenticates with `Authorization: Bearer <token>` and must not send an `Origin` header; the bridge answers `403` when the token is wrong or an `Origin` is present.

Both voice paths are off on a fresh install. The service still starts, `/health` returns `200` with `"sessionId": null` and `"legacy": {"enabled": false}`, and one voice turn speaks `The orchestration service is unavailable. Please try again later.` without queueing. Enable the bridge to give the turn a destination.

## 5. Verify

1. Check the bridge on the Jarvis side:

   ```sh
   curl -fsS http://127.0.0.1:8080/health | jq .bridge
   ```

   Expect `"enabled": true`, `"protocolVersion": 1`, `"deviceOnline": true` after the device connects, and `"connected"` at least `1` after the plugin handshakes. `lastHandshakeAt` confirms the handshake.

2. Check the panel's Source health. `bridge` should be `ready` with the same protocol version, and `device` should be `online`. The plain-English `detail` names the failure when it is not.

3. Speak one read-only question. The transcript appears as a Thread `jarvis:<deviceId>`, the answer streams as deltas while it is spoken, and the audited final is stored on the Thread. Speak a request that needs work: the Source asks a spoken confirmation before any work starts; a spoken yes continues, a no answers `Okay, cancelled.`

4. Inspect the logs. On the Jarvis side, look for `dsh_bridge_enabled` and the handshake stages. On the host side, the plugin's health entries are the contract; do not parse application logs for turns.

## 6. Roll back to the legacy client

The legacy direct Session client is the rollback path, and the two paths are never active together.

1. In the Source config, set `legacyDirectSession` to `true`. The Source stops the bridge client, reports `bridge` paused with `legacyDirectSession: true`, answers `gone`, and keeps running.
2. In the Jarvis `.env`, remove or set `JARVIS_DSH_BRIDGE=0`, then set `JARVIS_LEGACY_DSH_SESSION=1` and restart the service.
3. Verify: `/health` shows `"bridge": {"enabled": false}` and `"legacy": {"enabled": true}` with the session id the old client follows. `PUT /v1/session` works again; while legacy is off it returns `409`.

If both switches are set, the service ignores the bridge and logs that it did so: legacy wins and the bridge route is not mounted. To return to the bridge, disable legacy first, then re-enable the bridge; never leave both set and expect the bridge to answer.

The legacy path is rollback only. It follows one long-lived DSH Session for all voice turns and its announcements (`JARVIS_DSH_ANNOUNCE_SESSION`, `JARVIS_DSH_ANNOUNCE_DEVICE`) belong to that client. Voice-quality fixes land on the bridge path.

## 7. Runbook and failure modes

| Symptom | Check | Action |
| --- | --- | --- |
| `bridge` entry `error`: refused, 403 | Token file, `JARVIS_DSH_BRIDGE_TOKEN`, and whether a proxy adds an `Origin` | Fix the credential; the client reconnects with backoff. |
| `bridge` entry `error`: `Incompatible bridge protocol` | Both sides on protocol version 1 | Upgrade the plugin and the Jarvis service together. |
| `bridge` entry `paused`, detail `The legacy direct Session client is on` | `legacyDirectSession` | Turn the rollback switch off to resume the bridge. |
| `bridge` route answers `404` | `JARVIS_DSH_BRIDGE=1` and the service restart | Enable the bridge and recreate the container. |
| `device` entry `paused` / offline | The admitted device is connected and speaking | Bring the device online; announcements and replies are dropped, not queued. |
| Voice turn says the unavailable phrase | `bridge` health and the service logs | The bridge is down or no Jarvis source is connected; fix the connection. The turn is not retried automatically. |
| Announcement never arrives | `deviceOnline` and the bridge connection | Announcements are dropped while the device is offline; the Channel send returns `gone`. |
| `/health` has `sessionId: null` | Both paths off | Enable exactly one path. |

Known limits, accepted in v1:

- The Confirmation gate is a Soft constraint. The Main Session is instructed to ask before accepting work, and the Source speaks the question and consumes the answer, but a host that never calls the confirmation seam can bypass the gate. Only the prompt-level rule and the audible gate stand between a request and a Ticket.
- The voice prompt section is rendered only for turns carrying the Voice marker, and the marker reaches the plugin through its own turn tracking because the host candidate card does not carry the Trigger's `meta`. Prompt assembly timing is the host's; the audible gate does not depend on it.
- Turn-less announcements need a live device and a connected bridge. A result that arrives while the device is offline is dropped, not queued and not replayed on reconnect.
- The old direct Session client remains available only as the rollback path; do not mix its session switching with bridge turns.
