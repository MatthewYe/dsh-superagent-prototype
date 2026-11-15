# 0004 Host-native deployment is the primary path

- **Status:** Accepted
- **Date:** 2026-11-15
- **Deciders:** the maintainer, after migrating both live instances out of Docker
- **Supersedes:** [0002 Docker is the primary deployment](0002-docker-deployment.md)

## Context

dsh-superagent delegates real work to the macOS host. Its Executor Sessions run shell commands, open Xcode 27.2 and the iOS Simulator, read credentials from the macOS Keychain through `gh`, install tools with Homebrew, and speak to Slack over a Socket Mode WebSocket. Those are host capabilities, not Linux capabilities. A Linux container on Docker or OrbStack cannot run Xcode or the Simulator at all, cannot read the Keychain without exporting a copy of the secret, and cannot use the Homebrew prefix the operator's tools expect. `gh` itself must be recent enough (2.104 here) and signed in as the agent account, and the live instances depend on host tools that are not packaged in the image.

The Docker path worked for serving the panel and the management API: one image, one container per instance, a loopback relay and pinned DeepSeek Harness. It could not run the work the product exists to do. The alternatives do not close that gap:

- Docker and OrbStack run Linux containers. There is no macOS container runtime.
- A macOS virtual machine can expose a Simulator, but degrades graphics and GPU work, cannot nest Docker for the remaining tooling, and adds a second operating system to patch and back up.
- Exporting Keychain items into the container turns a host credential store into a file that the image, the Compose environment or a volume can leak.

Two instances were already running this way on the host before the Docker experiment: `superagent` on port 3082 and `livis` on port 3083, each with its own DeepSeek Harness profile and an absolute state directory. Moving them back is a return to the deployment that can execute the work, not a new experiment.

## Decision

Run each instance as a native macOS process under tmux, started and stopped by `scripts/dsh-superagent`:

- **One dedicated DSH profile per instance.** `superagent` and `livis` are separate DeepSeek Harness profiles, each linked to this checkout as a plugin. The tmux session is `dsh-<profile>`, so the two instances never share a process, a restart or a log.
- **An absolute `stateDir` per instance.** `~/.dsh/state/superagent` and `~/.dsh/state/livis` hold the database, lock, worker shims, git configuration and Tickets. The path is absolute and changes only with a deliberate migration. The orchestrator's `proper-lockfile` lock and the SQLite single writer mean one process owns one state directory; the supervisor refuses a duplicate instance rather than choosing one.
- **Loopback ports.** Each profile keeps DSH on `127.0.0.1:3082` or `127.0.0.1:3083`; the supervisor health-checks `<url>/orchestrator/api/state` and never publishes beyond loopback.
- **File-based credentials, mode 0600.** The DSH credential store stays at `~/.dsh/.credentials.yaml`; the agent GitHub CLI uses `~/.config/gh-agent/hosts.yml`; the Slack bridge stores `~/.slack-dsh-superagent/config.json`; the model key comes from `DEEPSEEK_API_KEY` or a password-manager reference resolved through `op run` (optionally from `~/.dsh/.env`). No credential is copied into the checkout, the repository, a log or a tmux command line.
- **The panel token comes from the log.** DSH prints its boot URL, including the per-boot token, on the `dsh web:` line. The supervisor redirects the process output to `.artifacts/dsh-superagent-<profile>-<timestamp>-<pid>.log` with `umask 077`; the operator reads the newest log and opens the URL. A restart rotates the token, so the log is the source of truth.
- **The supervisor owns lifecycle.** `start` creates the tmux session or a new window in it, records the pane PID, waits for readiness and exits with the established codes (0 ready, 1 not running/runtime error, 2 broken non-runtime part, 3 setup waiting). `stop` writes the manual-stop marker before SIGINT and waits up to five minutes for Executors; `restart` keeps automatic recovery enabled. `status` prints JSON and the same exit codes.
- **Upgrade is a checkout operation.** Stop or pause work, run `git pull && pnpm install && pnpm build`, restart the instance and confirm every health entry is `ready`. The database migration is one-way, so take a copy of `<stateDir>/orchestrator.sqlite` first.
- **Rollback is the retained Docker copy.** The pre-pivot containers and named volumes are stopped and kept for seven days after this decision. During that window the Docker path can be restarted with `scripts/dsh-superagent-docker` against those volumes; after it, the native checkout and state backups are the only rollback source.

The Docker assets remain in the repository as an opt-in, frozen path: `Dockerfile`, `compose.yaml`, `scripts/docker-build`, `scripts/docker-instance` and `scripts/dsh-superagent-docker`. They are for inspection and the rollback window, not the recommended installation.

## Consequences

Positive:

- Executors can run the same tools as the operator: Xcode and the Simulator, Keychain-backed `gh`, Homebrew binaries, macOS-only test runners and a real Slack Socket Mode connection.
- There is no image build in the normal change path. A product change is `git pull`, `pnpm build` and `restart`; debugging uses the same checkout and process the operator can inspect.
- Credentials stay in the host stores that already own them, with the same permissions the operator uses outside dsh-superagent.
- The two instances keep independent profiles, state directories, ports and tmux sessions, so one can restart or upgrade without touching the other.

Negative:

- There is no container isolation. Worker and router Sessions run with `danger-full-access` as the operator's macOS user, read the operator's home directory and can run anything that user can run. The account-wrapper convention separates credentials, not processes; a dedicated OS account is the only real isolation and is not part of this deployment.
- One instance per state directory, enforced by the lock and SQLite. The supervisor refuses to start a second process for the same profile, and a copied state directory must never be opened by two instances.
- The host's Node.js, pnpm, DeepSeek Harness, git, tmux and Python are now deployment inputs. A DeepSeek Harness upgrade for another profile can change the CLI under a running instance; restart the instance after upgrading it.
- The panel token rotates every boot and lives in a log file. An operator who opens a stale URL gets a 401 and must read the newest `dsh web:` line.
- There is no Compose restart policy. Recovery depends on the hourly check and the supervisor; a crash stays down until either runs.
- Docker remains a second, frozen path in the tree. Its tests are opt-in and its docs are marked experimental, so it can drift without the default suite noticing.

## Alternatives considered

- **Keep Docker as the primary path.** Rejected. The container cannot run Xcode, the Simulator, the Keychain-backed `gh` or Homebrew tools, so it serves the panel but cannot do the work. PR #18 and issue #1 implemented that path; this decision supersedes them.
- **Run a macOS virtual machine and deploy inside it.** Rejected. Simulator and GPU behavior degrade, Docker cannot be nested for the rest of the toolchain, and the operator would maintain a second macOS installation, its updates and its backups.
- **Run natively under `launchd` now.** Rejected for this round. A LaunchAgent would start at login and could own restarts, but it complicates interactive debugging, per-profile lifecycle and the existing tmux workflow the live instances use. tmux plus the supervisor is the smaller change and is already proven by both live instances. `launchd` remains a possible later wrapper around the same supervisor.
- **Use a macOS container runtime or a Linux VM with a macOS tool proxy.** Rejected. Neither exists as a supported runtime for this stack, and a proxy would still leave credentials and Simulator access outside the container.
- **Copy Keychain and Homebrew state into a Linux image.** Rejected. It exports credentials into image layers or volumes, breaks on rotation and does not supply Xcode or the Simulator.
- **Keep the Docker wrapper as `scripts/dsh-superagent` and hide the host path behind `--legacy`.** Rejected. It makes the path that can execute work the exceptional one, and every operator command would need a flag to reach it. The host supervisor takes the primary name; Docker moves to `scripts/dsh-superagent-docker`.

## Revisit when

- A supported macOS container or VM runtime can run Xcode, the Simulator, Keychain-backed `gh`, Homebrew and Docker without degrading them.
- dsh-superagent moves to a Linux host or a remote worker pool where container isolation is the stronger requirement.
- The seven-day Docker rollback window ends. Remove the stopped containers and volumes, and decide whether the frozen Docker path is still worth carrying.
- `launchd` becomes the desired supervisor for login-time recovery, or tmux stops being available on the target host.
- A dedicated OS account or a sandbox becomes the isolation boundary, changing the permissions and credential story in this record.
- DeepSeek Harness ships a supported service manager or a stable panel token that survives restarts, removing the log-scraping step.
