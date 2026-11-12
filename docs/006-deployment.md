# 006 Deployment

Use this guide to build, run, configure, upgrade and troubleshoot dsh-superagent. Docker is the primary deployment: one image, one container per instance. The host-profile installation is in the [appendix](#appendix-host-profile-installation) for development and the rollback window; `SETUP.md` follows that path.

The chapter builds on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md). The root `GLOSSARY.md` fixes the deployment vocabulary, and `docs/adr/0001-docker-deployment.md` records why the stack is shaped this way.

## Instances and profiles

An instance is one running copy of the product. It has its own DeepSeek Harness profile, state directory, panel port and container. The two instances share the image and the product code; they share no state.

| Instance | Profile | Host panel | State | Status |
| --- | --- | --- | --- | --- |
| `superagent` | `superagent` | `127.0.0.1:3082` | volume `superagent-state` | implemented |
| `livis` | `livis` | `127.0.0.1:3083` | planned | follow-up (#4) |

One container runs per state directory, because the orchestrator takes an exclusive lock on it, the SQLite database has one writer, and the panel token rotates per boot. Do not scale a service or share a state volume between containers.

The image currently carries only the `superagent` profile. The `livis` profile, the Livis source plugin and its service are not in the image or the Compose file yet; they arrive with the second-instance follow-up. Unqualified, `livis` below means the planned instance.

### What exists today

The Docker path carries the container skeleton from the deployment ticket and the credential and state-import path from #3. It is enough to build the image, start a credentialled instance, import the host's state once and use the panel and management API.

| Capability | Today | Follow-up |
| --- | --- | --- |
| Image, container, relay, healthcheck, panel | implemented and covered by the opt-in test | — |
| Real agent GitHub credential | implemented by `scripts/docker-instance`: Keychain token materialised as a 0600 file, mounted read-only, removed by `stop` | — |
| Model key and DSH credential | implemented by the start path: key from the environment or `op run`, DSH credential copied into the home volume | — |
| One-time import of host state | implemented after a SQLite WAL checkpoint, with an idempotent marker and an unchanged host copy | — |
| `livis` service and plugin | not implemented | #4 |
| `scripts/dsh-superagent` driving Compose | not implemented; the script is still the host tmux path | #5 |
| Hourly recovery of a Docker instance | not implemented; only the Compose restart policy | #5 |
| Cutover runbook | not written | #7 |

The opt-in test proves the implemented column: build, boot, unconfigured readiness, panel login, management API, health transitions, restart persistence on one image, the shim and credential plumbing, one-time import with an unchanged host copy, and teardown. It makes a real model call and checks usage only when the model key resolves; otherwise that assertion is skipped and reported. Live GitHub authentication is also skipped, and reported, when the Keychain token is rejected; the shipped stand-in still proves the shim and the git credential path.

## Docker path

### Prerequisites

- Docker Engine with Compose v2. The path is exercised on macOS 26.7 arm64 with Docker 29.4 (OrbStack) and Compose v5.1.2; Linux and remote Docker hosts are not tested.
- git 2.32 or later on the build host. `scripts/docker-build` reads the repository commit for the image tag.
- A checkout of this repository.
- A free loopback port, `3082` by default. A host-profile instance on `127.0.0.1:3082` conflicts; stop it or choose another published port.
- Enough free disk for the image and the build cache.

Node.js, pnpm, DeepSeek Harness, tmux and Python are not host prerequisites for this path; the image contains them. The appendix lists the host requirements.

### Build the image

From the repository root:

```sh
export SUPERAGENT_IMAGE="$(scripts/docker-build | tail -n 1)"
```

The script builds the image and prints its tag. The tag records the inputs:

```text
dsh-superagent:<first 12 characters of the repository commit>-dsh-<pinned DSH version>
```

For example, a build at commit `d527595e18c2` with the default DeepSeek Harness version produces `dsh-superagent:d527595e18c2-dsh-0.2.1-rc.3`. There is no registry or CI build in this round.

| Input | Default | Effect |
| --- | --- | --- |
| repository commit | `git rev-parse --short=12 HEAD` | product code and tag |
| `DSH_VERSION` | `0.2.1-rc.3` | DeepSeek Harness CLI installed in the image and tag |
| `SUPERAGENT_IMAGE` | the generated tag | tag to build and, later, the image Compose runs |

The image does not contain the Livis source plugin or the `livis` profile yet. A second instance will need a new image build; do not add the service to `compose.yaml` by hand.

### Run and stop the container

```sh
docker compose up --detach
docker compose ps
docker compose logs superagent
```

Compose requires `SUPERAGENT_IMAGE` and uses the tag exported above. The container starts in the background. On the first boot the entrypoint seeds the DSH home volume from the image's profile template; later boots keep whatever is on the volume.

The panel URL and its per-boot token are in the container log:

```sh
docker compose logs superagent | grep -o 'http://127.0.0.1:3082/?token=[A-Za-z0-9_-]*' | tail -n 1
```

Open that URL and choose **Superagent** in the sidebar. The token changes on every boot; re-read the log after a restart.

```sh
docker compose restart superagent
docker compose stop
docker compose down
```

`stop` and `down` keep the named volumes. `docker compose down --volumes` deletes the DSH home and the state; there is no undo.

The panel is published on `127.0.0.1` only. Do not add a `0.0.0.0` publish or a second port binding.

### Credentialled start (ticket #3)

Prefer `scripts/docker-instance` for a real instance. It wraps Compose and owns the per-instance credentials:

```sh
scripts/docker-instance start
scripts/docker-instance status
scripts/docker-instance stop
```

`start` reads the agent's GitHub token from the macOS Keychain (service `gh:github.com`, account `matthewye-agent`), takes the DSH credential store from `~/.dsh/.credentials.yaml` and imports `~/.dsh/state/superagent` into the state volume once, after a SQLite `wal_checkpoint(TRUNCATE)`. It then runs Compose and stores the panel URL. `status` prints that URL and the container state. `stop` removes the container and the runtime credential files but keeps both volumes; the next `start` reuses the imported state because a marker in the volume skips the import.

The model key comes from `DEEPSEEK_API_KEY` or from the 1Password references in `~/.config/op/llm.env`. When the variable is absent, the wrapper re-executes itself under `op run --env-file`; a signed-out or locked 1Password fails the start. A missing Keychain token, missing model key or unavailable image is a configuration error with exit code 2. Runtime failures exit 1.

Secrets live only in `.artifacts/instances/<instance>/` (mode 0700), never in this repository, [compose.yaml](../compose.yaml) or the image:

| File | Mode | Purpose |
| --- | --- | --- |
| `hosts.yml` | 0600 | the Keychain token for `gh`, bind-mounted read-only at the container's `/Users/matthewye/.config/gh-agent/hosts.yml`; removed by `stop` |
| `credentials.yaml` | 0600 | a copy of the host DSH credential store, bind-mounted read-only at `/run/superagent/credentials.yaml`; the entrypoint copies it into the home volume once |
| `compose.runtime.yaml` | 0600 | the generated override with those mounts and the model-key environment |
| `panel-url` | 0600 | the per-boot panel URL printed by `status` |

Use the sanitised copy described under [Volumes and state](#volumes-and-state) for tests, so an imported instance cannot poll the real repository or create Tickets.

### What the container contains

The image runs Debian bookworm slim with:

- the product built from the repository commit, its production dependencies and its `dsh` plugin entry;
- DeepSeek Harness pinned at `0.2.1-rc.3`, plus pnpm;
- the profile template generated from DeepSeek Harness's Web profile, with the product linked as a plugin, the web server on `127.0.0.1:3082` and the state directory at the absolute path below;
- the tools setup and workers need: `git`, `git-lfs`, `gh`, `python3`, `jq`, `curl`, `socat`, `bash` and `tini`.

It contains no credential, no copy of the operator's home directory and no source checkout. The entrypoint uses root only to seed the volumes and fix ownership, then runs the relay and DeepSeek Harness as uid 501, gid 20.

| Path | Purpose |
| --- | --- |
| `/data/dsh` | DSH home, volume `superagent-home` |
| `/data/dsh/profiles/superagent` | the instance's profile |
| `/opt/dsh-superagent` | the product code |
| `/opt/superagent-template` | first-boot profile template |
| `/Users/matthewye/.dsh/state/superagent` | state directory, volume `superagent-state` |
| `/usr/local/lib/superagent/relay.mjs` | the relay |

The worker and router presets still run with `danger-full-access`. Inside Docker the container and its volumes are the isolation boundary: a worker can read the instance's DSH home and state, including any credential that a later ticket installs there, and can write any source checkout that is later bind-mounted. It cannot read the rest of the host filesystem.

### Volumes and state

The Compose file defines two named volumes per instance:

| Volume | Mounted at | Holds | Lost when |
| --- | --- | --- | --- |
| `superagent-home` | `/data/dsh` | profile, plugin link, DeepSeek Harness settings and the imported DSH credential | `docker compose down --volumes` |
| `superagent-state` | `/Users/matthewye/.dsh/state/superagent` | orchestrator database, lock, command shims, git configuration, Tickets | `docker compose down --volumes` |

Named volumes keep the host's state directories out of the container's write path. The host copies at `~/.dsh/state/superagent` and `~/.dsh/state/livis` stay as they are, so a rollback does not depend on the container.

`scripts/docker-instance prepare` imports the host state into `superagent-state` once. It checkpoints the host SQLite WAL first, copies the directory into the volume, writes the `.imported` marker with the host hash, and verifies that the host copy did not change. Later starts keep the instance state and never import again. The host copy remains the rollback source. Do not copy the SQLite database into a running instance by hand: two writers would corrupt it, and the host copy would diverge from its hash.

Back up a volume before an upgrade. The database inside is `<stateDir>/orchestrator.sqlite`; use your Docker volume backup procedure and test the restore before the rollback window closes.

### Networking and the relay

DeepSeek Harness binds `127.0.0.1:3082` inside the container and keeps its loopback-only `Host` and `Origin` checks. A published port cannot reach that loopback address, so a small relay is the only non-loopback listener in the container:

| Hop | Address | Notes |
| --- | --- | --- |
| Host browser or `curl` | `127.0.0.1:3082` | the only published binding |
| Relay, inside the container | `0.0.0.0:13082` | forwards to the target below |
| DeepSeek Harness | `127.0.0.1:3082` | unchanged panel and management API |

Compose publishes `127.0.0.1:${SUPERAGENT_PUBLISH_PORT:-3082}:13082`. The relay rewrites `Host` to `127.0.0.1:3082`, and rewrites `Origin` to that same authority only when the incoming `Origin` matches the incoming `Host` (same-origin). DeepSeek Harness therefore sees its expected authority without the product code changing. The opt-in test asserts the only application listeners are the relay on `13082` and DeepSeek Harness on `127.0.0.1:3082`.

To avoid a conflict with a host-profile instance, publish another loopback port:

```sh
SUPERAGENT_PUBLISH_PORT=38082 docker compose up --detach
```

Then open `http://127.0.0.1:38082/?token=<token>`. The logged URL still names the container-internal `3082`; replace its port. The opt-in test uses `38082` to prove that an alternate published port works.

### Health and readiness

Compose runs `/usr/local/bin/superagent-healthcheck` every 5 seconds, with a 5-second timeout, three retries and a 60-second start period. The check calls the management API through the relay with `x-orchestrator-request: 1` and reports healthy only when:

- setup has no problem (`setup.problem` is `null`), and
- the `health` list is non-empty and every entry is `ready`.

A fresh, unconfigured volume is therefore unhealthy with `setup.problem.code = repositoryUnset`. That is the expected state, not a failed container. `docker compose ps` shows `starting` or `unhealthy` until the instance is configured and every part is ready.

The Compose file sets `restart: unless-stopped` for the container. There is no hourly check driving a Docker instance yet; `scripts/dsh-superagent` still supervises the tmux path and its four status exit codes do not apply to Compose until follow-up #5.

### Credentials

The image and the Compose file contain no token. That is deliberate: image layers, build arguments and container metadata are not a secret store. Nothing in this chapter asks you to put a token in `compose.yaml`.

`scripts/docker-instance` supplies credentials at start instead:

- the GitHub token is read from the macOS Keychain, written as a 0600 `hosts.yml`, mounted read-only, and removed by `stop`;
- the DSH credential store is copied into the private home volume on first start, not baked into the image;
- the model key is passed only as the Compose process environment; it is never a file in the repository or image;
- a missing GitHub token or model key stops the start with exit code 2 and an actionable message.

The image provides the same `gh-agent` path the imported `worker-gitconfig` and GitHub Source `cli` setting use. The entrypoint points it at the mounted container `hosts.yml`; git credential helpers therefore work without rewriting the imported state. A direct `docker compose up` without the runtime override still boots, but `gh` is unauthenticated and no model credential is present: use the wrapper for real work.

## Configure an instance

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A settings change runs setup again. If you fix something outside the application, such as CLI authentication, choose **Check again**.

1. **Sources.** Set the GitHub repository (`owner/name`) and the Agent CLI. On the host-profile path this is the agent wrapper, for example `/home/me/.local/bin/gh-agent`; in the container the imported setting names `/Users/matthewye/.local/bin/gh-agent`, which the image provides. Requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages.
2. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the GitHub accounts and Feishu users who may ask for work; until a list has someone, no request can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**.
3. **Execution.** The directory root and a prepare command. To give each Ticket a checkout of the repository:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   List personal CLIs, such as one signed in to your own account, as blocked commands. The Docker path does not bind a source clone into the container yet, so a prepare command cannot see a host checkout there; the Execution environment is complete only on the host-profile path until that bind mount lands.
4. **Prompts.** Set the team sections: the GitHub disclosure line, review bots, the commit author and the auto-merge condition.

### Management API

The panel uses a local HTTP API that agents can also call. `SETUP.md` uses it to save settings, and the service script reads `GET state`.

From the host, send requests to `http://127.0.0.1:<published port>/orchestrator/api/` with `x-orchestrator-request: 1`; the default published port is `3082`. On the Docker path the relay forwards the request to DeepSeek Harness. The host must be `127.0.0.1:<port>` or `localhost:<port>`. Missing headers or an `Origin` from another site receive 403.

API saves have the panel's permissions. They can change execution environment and setup account fields, unlike saves made through the main Session's tools.

Agents may rely on these routes and fields. The other routes in `src/app/api.ts` serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; and `masterId` |
| `GET settings` | `blocks`: `policy`, `eval` and `executor`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, and `revision`, its kind's form, and its setup `problem` when it has one; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, `ticket` (`id` and `title`) when it was for one, its `thread` when the store has it, and `dropped.at` and `dropped.reason`, `channelGone` or `channelIgnored` |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the block's new `revision`, `policy_changed` and `restarting`. `value` is the whole block, as `GET settings` holds it; a missing key takes its default |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Runs setup again by restarting dsh-superagent: `restarting: true`. Refused when setup has nothing to fix |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `GET prompts`, `PUT prompts` with `{"config", "baseRevision"}` | Reads the prompt configuration: `current`, with its `revision` and `config`, `defaults`, `sections`, the team sections in the order Sessions read them, `skillName`, the pattern of a team skill's name, `builtin`, the names a team skill cannot take, and `skillPrefix`, which Sessions load a skill's name under. Or saves it: the new `revision` |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a Ticket, as the panel does |

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself |
| `models` | Sessions waiting on a model-budget retry |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | Stored work described in [003 Execution](003-execution.md); delivery counts waiting work, while reply covers Channel messages |
| `worker` | Executor Session event handling; appears after its first failure |
| `github`, `feishu`, `history` | Source polling, events and history recovery |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision.
- 500: anything else.

The blocks:

- `source:github`, `source:feishu`: `{"enabled": true, "config": {…}}`. GitHub's config has `repository` and `cli`, and the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the repository and the default branch's CI; Feishu's has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, and `otherChats` as `"none"` or `"mentions"`.
- `policy`: `{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, and by `issues`, `pulls`, `comments` or `ci` for GitHub; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: `model`, `maxWorkers`, `directory`, `prepare` and `blockedCommands`. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

Changing a repository or CLI runs the corresponding setup check first. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is temporarily unavailable while the application restarts.

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

The CLI value is the Agent CLI path: `$HOME/.local/bin/gh-agent` on the host path, a path inside the container on the Docker path.

## Setup checks

Setup uses the DeepSeek Harness subprocess service, as worker shells do; in the container, both run inside the container. It removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

Setup verifies the GitHub repository and the agent's push access, writes the worker environment, and checks that git uses only the agent credentials for github.com. A Feishu setup failure disables only the Feishu Source.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`: `gh` runs the agent's CLI; `lark-cli` runs the bot's CLI; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. It selects the agent CLI as the github.com credential helper, rewrites GitHub SSH addresses to HTTPS and defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, git never prompts for credentials, and `GH_TOKEN` and `GITHUB_TOKEN` are removed.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Upgrade

1. Wait until no Executor is in the middle of a turn, or pause processing with `POST executor/pause`.
2. Back up the `superagent-state` volume. The database migration is one-way: an older image cannot open a database migrated by a newer one.
3. Build the new image from the new code, then recreate the container with its new tag:

   ```sh
   scripts/docker-build
   export SUPERAGENT_IMAGE=dsh-superagent:<new tag>
   docker compose up --detach
   ```

4. Inspect `docker compose ps`, `docker compose logs superagent` and the panel. A healthy container is not the same as a healthy instance; wait until every health entry is `ready`.

A restart ends running Assignments and starts replacements with recovery notes. Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked **Default updated** after upgrading.

The previous image tag stays in the local Docker cache, but rollback also needs the pre-upgrade volume backup because of the one-way migration. Restore the volume, set `SUPERAGENT_IMAGE` back to the previous tag and run `docker compose up --detach`.

The opt-in Docker test covers restarting the same image with the same volumes, not an image upgrade or a migrated database. A cutover runbook is follow-up #7.

### Agent presets

The worker and router presets move shell commands to the background after 5 seconds. A Session cannot load without its preset. Keep the `dsh-superagent-worker` and `dsh-superagent-router` rows in `cordis.patch.yml` while their Sessions are in use; otherwise resume fails with `agent-preset/not-found`.

## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log and the API show the English text below.

| Symptom | Cause and fix |
| --- | --- |
| `SUPERAGENT_IMAGE` is required | Build the image and export the printed tag, or set `SUPERAGENT_IMAGE` to an existing tag |
| The container is healthy for a while, then `unhealthy` | The healthcheck calls the management API through the relay; check `docker compose logs superagent` for a stopped runtime or a failed part |
| `docker compose ps` shows `unhealthy` and setup reports `repositoryUnset` | A fresh volume is unconfigured by design; configure the Source and start through `scripts/docker-instance`, which supplies the credentials. A direct `docker compose up` has none |
| `Bind for 127.0.0.1:3082 failed: port is already allocated` | A host-profile instance or another container owns the port; stop it or set `SUPERAGENT_PUBLISH_PORT` |
| The panel returns 401 | The token is per boot; re-read it from the container log after every restart |
| The URL from the log does not open when `SUPERAGENT_PUBLISH_PORT` is set | The log names the container-internal `3082`; replace the port with the published one |
| The relay answers 502 | DeepSeek Harness is not up yet or has exited; read `docker compose logs superagent` |
| The panel says dsh-superagent is not answering while the container is up | It is restarting, or its configuration stopped startup; the container log names the cause |
| State disappeared after `docker compose down` | `down --volumes` deletes the named volumes; without `--volumes` they survive |

The remaining setup and runtime rows apply to both paths:

| Symptom | Cause and fix |
| --- | --- |
| `The agent GitHub CLI is not set.` | Set the agent's CLI on the GitHub card |
| `The agent GitHub CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent GitHub CLI cannot read its account` | Sign the wrapper in with `auth login` |
| `@… cannot read …` or `@… cannot push to …` | Give the agent account write access to the repository |
| `The GitHub Source names no repository.` | Set the repository, `owner/name`, on the GitHub card |
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| `git does not read the github.com credential configuration dsh-superagent writes` | Install git 2.32 or later |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| `… was not written by dsh-superagent` | Move the named file out of `<stateDir>/worker-bin` or `<stateDir>/worker-gitconfig`, or choose another `stateDir` |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in the appendix |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator's user to see its own message |
| `dsh-superagent configuration has keys it does not use` (log) | Remove the named keys; the message says where each value lives now |
| The log says the plugin is incompatible with the running dsh | Use a DeepSeek Harness version within the `engines.dsh` range |
| The panel shows "Failed to load plugins" after a DeepSeek Harness upgrade | Restart the running instance |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. On GitHub, a mention added by editing an Issue's body is not received; mention the agent in a comment |

These three apply only to the host-profile control script:

| Symptom | Cause and fix |
| --- | --- |
| `status` exits 2 | A part reports an error, which a restart does not fix: `errors` names each part, as listed under Management API, with its detail; each part clears its own entry once it works again |
| `status` exits 3 | Setup waits: `setup` says what is missing, and the overview links to the setting that fixes it |
| `status` exits 1 | The service does not run, runs twice, does not answer, or its runtime reports an error; the output and the newest log say which |

## Appendix: host-profile installation

This is the pre-Docker installation kept for development and the rollback window. It runs the product as a DeepSeek Harness profile on the host, supervised by `scripts/dsh-superagent` in tmux; `SETUP.md` walks this path with an agent. It needs the host's Node.js, pnpm, DeepSeek Harness, git and tmux.

### What runs

- **A dedicated DeepSeek Harness profile**, called `superagent` in this guide. Create it from the Web profile template. It loads the bundle and serves its panel on `127.0.0.1`. Keep it separate from the profile you work in: the plugin changes process-wide `PATH` and git settings, and its process needs independent restarts and upgrades.
- **An agent GitHub account.** The agent comments, pushes branches and opens pull requests as this account, through a GitHub CLI signed in only as that account.
- **Optional:** a Feishu bot for chat requests.

Plugin configuration holds the state directory and machine limits. Use the panel for everything else: Sources for the repository and accounts, Policy for allowed lists, and Execution for worker directories and commands.

#### Permissions and isolation

The bundle defines `dsh-superagent-worker` for Executors and `dsh-superagent-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials by default; they do not isolate the process. A worker can execute programs by path and read the operator's home directory. For isolation, use a dedicated OS account containing only the agent's credentials.

### Prerequisites

- Node.js 22.19+ or 24+, pnpm, git 2.32+, Python 3.8+ and tmux
- GitHub CLI (`gh`) 2.48 or later. Source CLI fields must point to `gh` or `lark-cli` wrappers; the host relies on their subcommands and output formats.
- A repository on github.com; GitHub Enterprise Server is not supported. To create a checkout per Ticket, keep a local clone from which the prepare command can add worktrees. Install `git-lfs` if that repository uses Git LFS.
- A model channel configured for DeepSeek Harness. dsh-superagent uses the profile's default model unless the Eval or Execution settings name another.
- For Feishu: `lark-cli` (tested with 1.0.90) and a Feishu or Lark app with a bot

### Accounts

#### Agent GitHub account

1. Create a GitHub user account for the agent and give it write access to the repository. A GitHub App cannot be the agent, because dsh-superagent reads the account's notifications.
2. Give it a GitHub CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   Sign in as the agent account; the last command prints its login. dsh-superagent reads the login the same way.

#### Feishu bot (optional)

1. Create a self-built app with the bot capability. Grant it the permissions to receive message events, read and send chat messages, and read chat members, then publish the app version.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity, and a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   The first command reads the app secret from standard input. Use a separate configuration directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   The host refuses a CLI that can act as a user. It reads the app id, Feishu/Lark brand and bot `open_id` from the bot configuration.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.

### Install

Run this block once, on a machine that has no `superagent` profile yet:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

The pinned version above is public; other versions must satisfy `engines.dsh` in `package.json`.

The fourth command creates `~/.dsh/profiles/superagent` from the DeepSeek Harness Web template. The fifth installs this bundle. Set `DSH_HOME` to relocate the default `~/.dsh` directory.

Run the profile-creation command only for a new installation. If the profile already exists, that command replaces it and deletes its `cordis.patch.yml`, including machine configuration. Do not use it for upgrades.

### Machine configuration

Copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) to `~/.dsh/profiles/superagent/cordis.patch.yml`, replacing that file, and replace every `<placeholder>`. For Feishu, also enable the `dsh-superagent-feishu` entry there. The `webserver` entry sets the panel's port.

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | yes | Absolute path: the database, the lock, the command shims in `worker-bin`, the agent's git configuration and, by default, the Ticket directories in `work`. Back it up before upgrades |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | The largest saved prompt configuration, and how many Thread pages one assessment reads within what time |

After the first start, edit machine limits in **Settings → Deployment** or the DeepSeek Harness Plugin Manager. Changes apply without restart. `stateDir` cannot be changed there. Invalid values or unknown configuration keys prevent startup; the log identifies the key.

### Start and stop

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` runs `dsh --profile superagent` in tmux session `dsh-superagent`, or `dsh-<profile>` for another profile. It waits up to one minute for the runtime to become ready or report a setup requirement. On a first run it prints the missing setup information. It refuses duplicate instances, including ones started outside this script.

`stop` and `restart` request graceful shutdown and wait up to five minutes for Executors. They never force-kill the process or touch other tmux sessions.

`status` prints process ids, health and setup problems. For a different profile or port, use `--profile` and `--url`, or set `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL`.

`status`, `start` and `restart` exit with one of four codes:

| Code | Meaning |
| --- | --- |
| 0 | The service runs normally |
| 1 | It does not run, runs twice, does not answer, or its runtime reports an error; a restart may fix it |
| 2 | It runs, but a part other than the runtime, such as a Source or a Policy sync (`sync:<source id>`), reports an error; a restart does not fix it |
| 3 | It runs and waits for setup; a restart does not fix it |

A Source that is still starting counts as normal operation. So does a Feishu bot that setup could not check.

`status` returns failed parts and their details under `errors`, and setup requirements under `setup`. `start` and `restart` print those problems as lines; they exit 1 if the service never comes up. Only an intentional `stop` pauses automatic recovery.

Each profile stores logs and control files under `.artifacts/`:

- Startup logs: `dsh-superagent-<profile>-<date>-<time>-<pid>.log`, where the pid belongs to the script. The newest 20 are kept.
- Control files: `control/profiles/<profile>/`, containing the stop marker, lock and process id.

Open the URL printed in the log, then choose **Superagent** in the sidebar.

#### Hourly check

Create the hourly check in the DeepSeek Harness profile you normally use, not in `superagent`. It must keep running when the agent service is down. Ask an agent in that profile to create an hourly schedule using this prompt, with the checkout path filled in:

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` preserves an intentional stop. Only `stop` writes the marker; `start` clears it. `restart` writes no marker, so the check can recover a restart whose shutdown timed out.

### Host upgrade

1. Wait until no Executor is in the middle of a turn.
2. Back up `<stateDir>/orchestrator.sqlite`.
3. Run `git pull && pnpm install && pnpm build`.
4. Run `scripts/dsh-superagent restart` and inspect its status.

A database migrated by a newer version cannot be opened by an older one. Rollback therefore requires the pre-upgrade backup. After upgrading DeepSeek Harness itself, restart the running instance so the panel loads matching artifacts.

### Try it

From an allowed GitHub account, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), Overview should show a Ticket. The agent acknowledges the request, works in its own Session and directory, and delivers in the original conversation. For Feishu, mention the bot in a configured chat.
