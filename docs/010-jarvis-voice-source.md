# 010 Jarvis Voice Source

This document is the operator guide for the Jarvis source: the Source that turns one completed Voice turn into one Trigger and speaks the answer back through the DSH bridge. The terms are defined in `GLOSSARY.md` at the repository root; the design and its accepted trade-offs are in `docs/adr/0003-jarvis-voice-source.md`. The source is the `dsh-source` package in the Jarvis repository; this repository only loads it and never contains its code.

The bridge protocol is pinned at **version 1**, path `/v1/dsh-bridge`. Upgrade the Jarvis service and the plugin together: a version mismatch is reported as `Incompatible bridge protocol` and no turn is accepted.

## 1. Prerequisites

- A working dsh-superagent instance on the `superagent` profile, with its panel reachable. The default deployment is Docker; the host-profile path is the [host-profile appendix](006-deployment.md#appendix-host-profile-installation) of [006 Deployment](006-deployment.md).
- A Jarvis checkout containing `dsh-source/` and `service/`. Node.js 22.18 or newer is needed to run the plugin's TypeScript sources; there is no build step.
- The Jarvis service reachable from the DSH process, with its speech service configured (`AUDIO_URL`).
- The DSH launch token: the token DSH prints in its panel URL. DSH issues a new one on every boot, so the plugin's and the service's copies must be refreshed after every DSH restart.

Docker and the host profile keep the profile and the token in different filesystems. Pick the layout that matches the DSH deployment:

| | Docker (default) | Host profile (`--legacy`) |
| --- | --- | --- |
| DSH process | in the `superagent` container, `HOME`/`DSH_HOME` = `/data/dsh` | on the host, `~/.dsh` (or `DSH_HOME`) |
| Jarvis checkout | on the host; not in the image | on the host |
| Profile file | `/data/dsh/profiles/superagent/cordis.patch.yml` (or the equivalent mounted profile path) | `~/.dsh/profiles/superagent/cordis.patch.yml` |
| Plugin path | `/data/dsh/jarvis/dsh-source` in the home volume | the checkout's `dsh-source/` |
| Token the plugin reads | `/data/dsh/jarvis/dsh-launch-token` (a second copy) | `<jarvis>/service/auth/dsh-launch-token` (the service's file) |
| Restart after install | `scripts/dsh-superagent restart` | `scripts/dsh-superagent --legacy restart` |

The plugin and the Jarvis service are separate processes. In Docker they are also separate containers with separate filesystems, so the token file has to exist on the DSH side and on the service side; in the host profile one file can serve both. The file must be mode `600`.

## 2. Install the plugin

`dsh-source/node_modules` is not committed — only the lockfile is — and `dsh plugin add link:` links the package without installing its dependencies. A fresh checkout therefore fails to load with `ERR_MODULE_NOT_FOUND` unless its dependencies are installed first:

```sh
cd /path/to/jarvis/dsh-source
npm install
```

Do not edit dsh-superagent's own source files; the plugin lives outside this repository.

### Docker (default)

Run these from the Jarvis checkout on the host, with the superagent instance running. The instance's Compose project is `dsh-superagent-superagent` unless `SUPERAGENT_PROJECT` overrides it; the Home volume is what the container calls `/data/dsh`.

```sh
cd /path/to/jarvis
cid="$(docker ps -q \
  --filter label=com.docker.compose.project=dsh-superagent-superagent \
  --filter label=com.docker.compose.service=superagent)"
uid="$(docker exec "$cid" printenv OPERATOR_UID)"
gid="$(docker exec "$cid" printenv OPERATOR_GID)"
docker exec "$cid" mkdir -p /data/dsh/jarvis
docker cp ./dsh-source "$cid:/data/dsh/jarvis/"
docker exec "$cid" chown -R "$uid:$gid" /data/dsh/jarvis
docker exec -u "$uid:$gid" "$cid" dsh plugin --profile superagent add "link:/data/dsh/jarvis/dsh-source"
```

The plugin now lives in the home volume, so a container restart keeps it. Append the plugin entry to the profile file once — the file exists after the first boot:

```sh
docker exec -i "$cid" tee -a /data/dsh/profiles/superagent/cordis.patch.yml <<'YAML'
- insert:
    - id: dsh-superagent-jarvis-source
      name: jarvis-dsh-source
YAML
```

### Host profile

```sh
cd /path/to/jarvis/dsh-source
npm install
dsh plugin --profile superagent add "link:$PWD"
```

Add the same entry inside the existing top-level list in `~/.dsh/profiles/superagent/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-superagent-jarvis-source
      name: jarvis-dsh-source
```

### After either path

Restart the instance — `scripts/dsh-superagent restart` for Docker, `scripts/dsh-superagent --legacy restart` for the host profile. The restart is required: the plugin is discovered at boot, not when the panel opens. The panel then lists the Source kind `jarvis` under **Settings → Sources**.

The plugin also registers the Main Session voice prompt section itself, as `jarvis:voice` at order 130. The section is registered for Main Session agents on every boot; its text renders only on turns carrying the Voice marker. The host's `PromptSection` type has no separate `required` flag — the section is always in the composition and is empty on other turns.

## 3. Configure the Source

Create the `jarvis` Source in the panel (**Settings → Sources**). The settings store keeps exactly one instance per Source kind, so the `jarvis` kind has one entry; there is no second instance to create. The instance config is re-read while the Source runs, so edits apply without a restart.

| Key | Required | Meaning |
| --- | --- | --- |
| `url` | yes | Bridge base address, for example `ws://127.0.0.1:8080`. `/v1/dsh-bridge` is appended when missing. In Docker, `127.0.0.1` is the DSH container itself; see section 4 for the address to use. |
| `deviceId` | yes | The one admitted device id (lowercase `[a-z0-9][a-z0-9._-]{0,63}`). Turns and channel replies for any other device are ignored. The Jarvis service accepts only lowercase letters, digits and `-`, at most 32 characters, so pick an id that satisfies both. |
| `enabled` | no | `true` by default. `false` stops the client, reports `bridge` and `device` as `paused`, and leaves the kind installed. |
| `tokenFile` | no | Absolute path of the file holding the DSH launch token. Set it explicitly; see the token note below. |
| `legacyDirectSession` | no | Advanced rollback switch, `false` by default. See section 6. |

The token is resolved on every connection attempt in this order:

1. `JARVIS_DSH_BRIDGE_TOKEN` — an explicit token from the DSH process environment;
2. `tokenFile` from the config;
3. `JARVIS_DSH_BRIDGE_TOKEN_FILE` — a path from the environment;
4. `service/auth/dsh-launch-token`, relative to the DSH process's working directory.

Relative paths resolve against the DSH process, never the Jarvis checkout: on the host path the working directory is the dsh-superagent checkout, and the Docker image's is `/opt/dsh-livis`. The default therefore does not find the Jarvis file in either deployment; always set an absolute `tokenFile`. If no credential can be read, the `bridge` health entry reports an error naming the expected path, and writing the file there recovers without a restart; the plugin re-reads the file on every attempt.

Getting the token right depends on the deployment:

- **Host profile.** Point `tokenFile` at `<jarvis>/service/auth/dsh-launch-token` on the host. The Jarvis service reads the same file through its `/auth` mount.
- **Docker (default).** The DSH container cannot read the host's Jarvis directory. Copy the current token into the home volume, e.g. `/data/dsh/jarvis/dsh-launch-token`, and set `tokenFile` to that absolute path. The Jarvis service keeps its own copy in `<jarvis>/service/auth/dsh-launch-token`; refresh both after a DSH restart. `JARVIS_DSH_BRIDGE_TOKEN` also works but puts the credential in the container environment (visible to `docker inspect`), so the file is preferred.

The token file must be mode `600` and readable by the process that reads it: the DSH container user (`OPERATOR_UID:OPERATOR_GID`) for the Docker copy, the host user running the host profile, and the service's `JARVIS_UID:JARVIS_GID` for the Jarvis copy (section 4).

## 4. Configure the Jarvis service

The Jarvis service is a separate process with its own filesystem. In the Jarvis checkout, create the two local directories and put the **current** DSH launch token in place:

```sh
cd /path/to/jarvis
mkdir -p service/auth service/state
chmod 700 service/auth service/state
# write the current DSH launch token as service/auth/dsh-launch-token
chmod 600 service/auth/dsh-launch-token
```

Set these in the Jarvis `.env` (Compose passes them through), then recreate the container:

| Variable | Value | Meaning |
| --- | --- | --- |
| `JARVIS_DSH_BRIDGE` | `1` | Enables the bridge route. Without it the route answers `404` and the plugin never connects. |
| `JARVIS_DSH_BRIDGE_DEVICE` | the same value as `deviceId` | The one admitted device. The handshake is refused when it does not match. |
| `DSH_URL` | the dsh-superagent base URL as the service sees it | Required by Compose; used by the legacy rollback path's `/connect` call, not by the bridge. |
| `JARVIS_LEGACY_DSH_SESSION` | `0` (or unset) in normal operation | Enables the old direct Session client; set to `1` only for rollback (section 6). |

```sh
JARVIS_UID="$(id -u)" JARVIS_GID="$(id -g)" docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:8080/health | jq .
```

`compose.yaml` runs the service as `JARVIS_UID:JARVIS_GID` (default `1000:1000`), bind-mounts `./service/auth` read-only at `/auth`, and `./service/state` at `/state`. `service/state` must be writable by that user — the legacy path writes its `session-id` there with mode `600`. Passing `JARVIS_UID`/`JARVIS_GID` equal to the host user keeps ownership of the files the service reads; otherwise `chown` both directories to the service's uid and gid. A token file the service user cannot read produces `Jarvis DSH bridge: could not read launch token: ...` and a `403` handshake refusal.

The service binds `0.0.0.0:8080` inside its container; `compose.yaml` publishes that to `127.0.0.1:8080` on the host only. Keep it that way: the bridge is a private link with a bearer token and no TLS, and it rejects any request carrying an `Origin` header. Never publish or reverse-proxy port `8080` to a public network.

The plugin's `url` must be a base address the DSH process can reach:

- host profile: `ws://127.0.0.1:8080`;
- Docker DSH: `127.0.0.1` is the DSH container itself, so use the Docker host's name (`ws://host.docker.internal:8080` where the Docker host provides it, such as Docker Desktop) or put both containers on one private network and use the service's network address. Do not use the host's public address.

### The launch token rotates

DSH prints a new panel token on every boot, and that token is the launch credential both sides use. The bridge compares the plugin's `Authorization: Bearer` against the service's token file rather than calling DSH, so two stale-but-equal copies still handshake; the copies are still out of date, and the legacy `/connect` path, which DSH validates itself, then fails with `DSH rejected the launch token: HTTP 403` (the turn errors and nothing is spoken). Refresh the service file, and the plugin's Docker copy, after every DSH restart. From the dsh-superagent checkout (reusing `cid`, `uid` and `gid` from section 2):

```sh
token="$(scripts/dsh-superagent logs --tail 200 | grep -o 'token=[A-Za-z0-9_-]*' | tail -n 1 | cut -d= -f2)"
printf '%s\n' "$token" | docker exec -i "$cid" sh -c 'umask 077; cat > /data/dsh/jarvis/dsh-launch-token'
docker exec "$cid" chown "$uid:$gid" /data/dsh/jarvis/dsh-launch-token
```

For the host profile, grep the newest `.artifacts/dsh-superagent-superagent-*.log` for the same `token=` parameter and overwrite `<jarvis>/service/auth/dsh-launch-token`. In both deployments, write the service's copy too (the file mounted at `/auth`), then confirm `/health`.

Both voice paths are off on a fresh install. The service still starts, `/health` returns `200` with `"sessionId": null`, `"bridge": {"enabled": false}` and `"legacy": {"enabled": false}`, and a voice turn speaks `The orchestration service is unavailable. Please try again later.` and is not queued. Enable the bridge to give the turn a destination.

## 5. Verify

1. On the Jarvis side, check the bridge snapshot:

   ```sh
   curl -fsS http://127.0.0.1:8080/health | jq .bridge
   ```

   Expect `"enabled": true`, `"protocolVersion": 1`, and `"connected"` at least `1` after the plugin handshakes. `"lastHandshakeAt"` is a Unix millisecond timestamp set by the last successful `hello.ok`; it is `null` before the first handshake. `"deviceOnline"` is not the plugin connection: it is true only while a `/v1/voice` conversation is open or the legacy announcement target is online, so it is normally `false` when nobody is talking.

2. On the panel side, the plugin's health entries are the contract. The `bridge` entry is `ready` with `connected: "true"`, `protocolVersion: "1"`, and an ISO `lastHandshakeAt`; the `device` entry is `ready` with `values.presence` `online` or `speaking` when the device is reachable, and `paused` with `presence: "offline"` otherwise. When either is not healthy, the plain-English `detail` names the failure.

3. Speak one read-only question. The transcript appears as a Thread `jarvis:<deviceId>`, the answer streams as deltas while it is spoken, and the audited final is stored on the Thread.

4. Speak a request that needs work. The Main Session is instructed to ask a short spoken confirmation that names the work before accepting it; a spoken yes is the go-ahead and a no is a refusal. This is a prompt-level rule, not a host gate; see the known limits.

5. Inspect the service log. A voice turn prints `jarvis_voice trace_id=... stage=dsh_bridge_enabled` when the conversation starts, then `stage=ready` and `stage=dsh_bridge_online` when the bridge control is ready. Errors print `Jarvis DSH bridge: ...` or `Jarvis voice: ...`. There is no success line for the WebSocket handshake itself; confirm the handshake with `/health` (`connected`, `lastHandshakeAt`). On the host side, do not parse application logs for turns; the plugin's health entries are the contract.

## 6. Roll back to the legacy client

The legacy direct Session client is the rollback path, and the two paths are never active together. The service validates the legacy `/connect` call against DSH itself, so rollback needs the **current** DSH launch token — a stale `service/auth/dsh-launch-token` fails with `DSH rejected the launch token: HTTP 403`.

1. In the Source config, set `legacyDirectSession` to `true`. The Source tears down the bridge client and reports both health entries as paused:
   - `bridge`: detail `The legacy direct Session client is on`, values `connected: "false"`, `protocolVersion: "1"`, `url`, and `legacyDirectSession: "true"` (the value is the string `"true"`, not a boolean);
   - `device`: detail `The DSH bridge is off while the legacy direct Session client is enabled`, values `presence: "offline"` and `deviceId`.

   No bridge turn is accepted while the flag is on.

2. In the Jarvis `.env`, set `JARVIS_DSH_BRIDGE=0` and `JARVIS_LEGACY_DSH_SESSION=1`, refresh `service/auth/dsh-launch-token`, and recreate the container:

   ```sh
   JARVIS_UID="$(id -u)" JARVIS_GID="$(id -g)" docker compose up -d
   ```

   Compose applies environment changes on recreate, not on `restart`.

3. Verify `/health`: `"bridge": {"enabled": false}`, `"legacy": {"enabled": true}`, and `"sessionId"` once the legacy client has selected a Session. In legacy mode `/health` answers `500` until `service/state/session-id` exists. `PUT /v1/session` switches the followed Session again and returns `409` while legacy is off.

If both switches are set, the service ignores the bridge and logs `Jarvis voice: JARVIS_LEGACY_DSH_SESSION=1, so JARVIS_DSH_BRIDGE is ignored; the two voice paths are never active together`; the bridge route is not mounted. To return to the bridge, disable legacy (and recreate), then enable the bridge.

The legacy path is rollback only. It follows one long-lived DSH Session for all voice turns, and its announcements (`JARVIS_DSH_ANNOUNCE_SESSION`, `JARVIS_DSH_ANNOUNCE_DEVICE`) belong to that client. Voice-quality fixes land on the bridge path.

## 7. Runbook and failure modes

| Symptom | Check | Action |
| --- | --- | --- |
| `bridge` entry `error`: `The DSH bridge refused the launch token (HTTP 403)` | Both token copies hold the current DSH token; the service user can read `/auth/dsh-launch-token` | Refresh both copies from the current panel URL (section 4); the plugin reconnects with backoff. |
| `bridge` entry `error`: `No DSH bridge credential: write the Jarvis launch token to <path> or set JARVIS_DSH_BRIDGE_TOKEN` | That path, its mode, and the DSH user's read access | Write the token at that path or set an absolute `tokenFile`; the plugin re-reads it on each attempt. |
| `bridge` entry `error`: `Incompatible bridge protocol` | Both sides speak protocol 1 | Upgrade the plugin and the service together. |
| `bridge` entry `error`: `The DSH bridge refused the handshake: device "X" is not admitted by this Jarvis` | The Source's `deviceId` versus `JARVIS_DSH_BRIDGE_DEVICE` | Make them equal and recreate the service container. |
| `bridge` entry `paused`: `The legacy direct Session client is on` | `legacyDirectSession` in the Source | Turn the rollback switch off to resume the bridge; section 6. |
| `bridge` entry `paused`: `The Jarvis Source is off` | `enabled` in the Source | Set `enabled: true`; config is re-read without a restart. No handshake is attempted while off. |
| `bridge` route answers `404` | `JARVIS_DSH_BRIDGE=1` and whether the container was recreated | Set it in `.env` and run `docker compose up -d`; `docker compose restart` does not re-read the environment. |
| `bridge` entry `paused`: `The DSH bridge is unavailable: ...` | The `url` and the route from DSH to the service | Fix the address (section 4). Never publish the bridge. |
| `device` entry `paused` / `offline` | The device is online and speaking | Bring the device online; announcements and replies are dropped, not queued. |
| Voice turn speaks the unavailable phrase | `/health` `bridge.connected`, both switches, the service log | If the bridge is configured but no plugin is connected, the log shows `stage=dsh_bridge_unavailable_spoken`; if neither path is on, `stage=no_voice_path_spoken`. Fix the path and speak again; the turn is not retried. |
| Announcement never arrives | `deviceOnline` and the bridge connection | Announcements are best-effort: the service holds at most one and drops it while the device is offline, so nothing is queued for a later reconnect. |
| `/health` shows `sessionId: null` | `legacy.enabled`; null is normal for bridge-only, which keeps no direct Session | Do not read null as "both paths off". Both off means `bridge.enabled` is false **and** `legacy.enabled` is false. |
| Legacy `/connect` gets `403` after a DSH restart | The service log line `DSH rejected the launch token: HTTP 403` | Refresh `service/auth/dsh-launch-token`; it is read per connection, so no service restart is needed. |
| `403` with an `Origin` present | A proxy or browser is in front of the bridge | Remove the `Origin` header; do not expose the bridge. |

Known limits, accepted in v1:

- **The confirmation and the execution strength are soft constraints.** The Main Session is instructed to ask for a spoken confirmation before accepting work, but the model can misread a turn, or be argued out of asking, and dispatch work without one; nothing in code stops it. Prompt wording is the only defence in v1, and there is no structured pending-confirmation state the Source sees or consumes — the answer stays in the Main Session's turn. A code-enforced gate would be a new decision.
- The voice prompt section (`jarvis:voice`, order 130) is registered by the plugin and rendered only on turns carrying the Voice marker. The host's `PromptSection` type has no separate `required` flag, so the section is always part of the composition and empty on other turns. The marker reaches the plugin through its own turn tracking, because the host candidate card does not carry the Trigger's `meta`.
- Turn-less announcements need a live device and a connected bridge. A result that arrives while the device is offline is dropped, not queued and not replayed on reconnect.
- If the bridge reconnects mid-answer, the unspoken remainder is lost; the final audited text is still stored.
- One device per Source in v1: only `deviceId` is admitted, for turns and for channel replies.
- The old direct Session client remains available only as the rollback path; do not mix its session switching with bridge turns.
