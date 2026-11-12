# Docker is the primary deployment

**Status:** accepted; implemented for the local Docker path. The image, the in-container relay, the healthcheck, both Compose services, the credentialled start path, the one-time state import, the operator wrapper and the `livis` instance with its plugin are implemented. The live relay-identity cutover (#7) is a follow-up.

Run each dsh-superagent instance as its own container from an image built out of this repository, with the management API kept loopback-only and a small in-container relay making the panel reachable through a loopback-published port.

## Context

The host-profile installation works but is long: Node, pnpm, a global DeepSeek Harness CLI, a cloned checkout, a generated DSH profile and a tmux control script on every machine. Upgrading DeepSeek Harness for another profile can change the CLI under a running instance. Two instances (the `superagent` and `livis` profiles) share the same product and need to stay apart in state, credentials and port. Docker gives one pinned, reproducible host per instance and a natural place for the second profile.

Three properties constrain the design:

- **The management API is loopback-only.** DeepSeek Harness serves the panel and the `/orchestrator/api/` routes on `127.0.0.1:3082`, and dsh-superagent checks the `Host` header and same-origin `Origin` before serving. A Docker port publish connects to the container's network interface, not to its loopback address, so publishing `3082` directly cannot reach a server bound to `127.0.0.1`.
- **Every instance owns a state directory.** The orchestrator takes an exclusive lock on `<stateDir>`, its SQLite database has a single writer, and the DSH web server rotates a panel token per boot. Two containers cannot share one state directory, and a container cannot be replicated.
- **Credentials must not enter the image.** The agent GitHub token comes from the macOS Keychain, the model key comes from a password manager, and the DSH credential is a file. Baking any of them into an image layer would leak them into the Docker cache and any future registry, and would make rotation a rebuild.

The host state directories at `~/.dsh/state/superagent` and `~/.dsh/state/livis` are the rollback copy. The deployment may import them once but must never write to them afterwards.

## Decision

- **One image with both profiles.** `scripts/docker-build` builds from this checkout with a pinned `DSH_VERSION`, a named BuildKit context for the sibling dsh-livis checkout (`LIVIS_DIR`), and tags the result `dsh-superagent:<12-char-commit>-livis-<12-char-livis-commit>-dsh-<dsh-version>`. `SUPERAGENT_IMAGE` overrides the tag. The tag records the two source inputs and the CLI; there is no registry or CI pipeline in this round. The image bakes the `superagent` profile and a second `livis` profile whose plugin is installed from the dsh-livis context, so both services share one build.
- **One container per instance and state directory.** `compose.yaml` defines a Compose service per instance. One service runs one container on one state-dir volume; the stack is never scaled. `superagent` and `livis` are implemented: same image, different profile template, state volume, DSH-home volume, container-internal port (`3082`/`3083`) and relay port (`13082`/`13083`). The `livis` refresh token is a rotating credential with exactly one owner, so the container must not sign in while the host livis instance holds the token; the live identity cutover is #7.
- **Named volumes, not bind mounts, for data.** Each instance gets a DSH-home volume at `/data/dsh` and a state volume at its absolute state-directory path. The first boot seeds the home from the image's profile template; the state volume is imported once from the host copy after a SQLite WAL checkpoint. The host directories stay untouched as the rollback copy. A bind mount of the operator's source checkout is a planned exception for the Execution environment; it is not in the Compose file yet.
- **Loopback publish through an in-container relay.** DeepSeek Harness keeps binding `127.0.0.1:3082` inside the container. A Node relay listens on the container's wildcard `13082`, forwards to `127.0.0.1:3082`, rewrites `Host` to `127.0.0.1:3082`, and rewrites `Origin` only when it matches the incoming `Host` (same-origin). Compose publishes `127.0.0.1:${SUPERAGENT_PUBLISH_PORT:-3082}:13082`. The `livis` service is the same relay parameterised to `13083 → 127.0.0.1:3083`, published as `${LIVIS_PUBLISH_PORT:-3083}`. Each default keeps the host, relay and DSH ports aligned (`3082` → `13082` → `3082`, `3083` → `13083` → `3083`), so the browser's `Host` and `Origin` are the ones DeepSeek Harness expects. Alternate loopback publish ports also work because the relay rewrites both headers; the opt-in end-to-end tests exercise `38082` and `38084`. No port is published on a non-loopback address.
- **The container adapts to the product, not the reverse.** The entrypoint seeds the DSH home on first boot, fixes ownership, starts the relay as the operator uid, and execs DeepSeek Harness as that uid. No product TypeScript changes for containerization. The healthcheck calls the management API through the relay with the required request header and reports healthy only when setup has no problem and every health entry is `ready`.
- **Credentials are runtime inputs.** Nothing in the image or Compose file carries a token. The operator path resolves the GitHub token through `gh auth token` or the Keychain, validates it with `gh api user`, and only then materialises it into a mode-0600 container-only file; it injects the model key from the environment or through `op run` at start, and removes the credential file on stop. Missing or rejected credentials fail the start with exit 2. The host wrapper `scripts/docker-instance` does this; Compose by itself does not. The `livis` profile does not need the model key: it signs in through the DSH credential store copied into its home volume, and its own refresh token stays on the state volume. The wrapper requires the DSH credential store for `livis` but not `DEEPSEEK_API_KEY`, and selects the instance by name (or `SUPERAGENT_INSTANCE`).
- **Compose is the contract; the operator wrapper drives it.** The existing `scripts/dsh-superagent` control script keeps its interface: it selects an instance, maps `start`/`stop`/`restart`/`status`/`logs`/`build` onto Compose, preserves the four readiness exit codes, and keeps the legacy rollback path behind `--legacy`. Compose stays the surface those commands call.

## Consequences

Positive:

- One image is the deployment unit, built from this repository; the host's Node, pnpm, tmux and DeepSeek Harness installation stop mattering.
- DeepSeek Harness is pinned in the image, so upgrading it for another profile cannot change a running instance. The upgrade unit becomes an explicit image tag.
- Named volumes keep host state out of the container's write path, so the pre-migration directories remain a clean rollback copy.
- The management API stays loopback-only inside the container, and only loopback ports are published on the host.
- A fresh volume visibly boots unconfigured and unhealthy, which the opt-in test asserts instead of hiding.

Negative:

- Every product change needs a new image build and container recreate; there is no hot reload of the product.
- The relay is an extra hop and the riskiest assumption. The opt-in test proves the panel, management API and healthchecks through an alternate published port (`38082`), plus restart persistence and teardown, but not streaming or WebSocket upgrades explicitly.
- Only macOS arm64 with Docker 29 / Compose v5 has been exercised. Linux, remote hosts and Kubernetes are out of scope.
- The live `livis` relay identity and any reconnect as the `hermes-…` agent are not exercised until cutover (#7); the opt-in test deliberately uses a rejected refresh token and an inert copy of the state. The `livis` plugin is built from a separate checkout, so its commit and lockfile are build inputs that this repository does not pin. The operator wrapper recovers a Docker instance hourly through the existing check, while a crashed container is left to Compose's restart policy.
- The DSH database migration on upgrade is one-way; rollback needs the previous image tag and a volume backup.
- `docker compose down --volumes` destroys instance state; there is no undo.
- The opt-in Docker test is skipped in the default suite, so these contracts are not continuously guarded by CI.

## Alternatives considered

- **Host networking or publishing `3082` directly.** Rejected. Host networking is platform-dependent and was not exercised here, and a published port reaches the container interface, not its loopback bind. Publishing an internal wildcard bind would expose the management API beyond loopback and weaken the Host/Origin checks.
- **Change the product to bind `0.0.0.0` or accept any `Host`.** Rejected. It widens the management API's exposure for a packaging problem, diverges from upstream and is outside this round's no-TypeScript-change constraint.
- **Run a reverse proxy on the host.** Rejected. It adds another installation to manage, still cannot reach the container's loopback bind without a container-side listener, and gives up per-instance port parity. The relay is the same idea localized to one container.
- **Bind-mount the host state directories.** Rejected for data. Bind mounts on macOS add file-sharing latency and ownership surprises for SQLite WAL files, let the container mutate the rollback copy, and cannot enforce the one-container-per-directory lock across hosts. The source checkout remains a planned bind mount because it must be the operator's real worktree.
- **Share one state volume between containers or scale the service.** Rejected. The state-directory lock, the single-writer SQLite database and the rotating panel token all assume one process per state directory.
- **Keep the host-profile installation as the primary path.** Rejected. It does not pin DeepSeek Harness per instance, does not isolate the two profiles, and repeats a long manual install on every machine.
- **Bake credentials or a generated profile with secrets into the image.** Rejected. Image layers and the build cache are not a secret store; rotation would require rebuilding and every instance would share the same token.
- **Add a registry and CI image pipeline now.** Rejected for this round. A local build keeps the tag tied to the commit and avoids infrastructure the project does not yet need. This is a scope decision, not a claim that a registry is undesirable.

## Revisit when

- DeepSeek Harness can bind or advertise a configurable public URL, or the management API can be served behind a proxy without header rewriting. The relay then loses its reason to exist.
- A Linux, remote or Kubernetes target arrives. Host networking, bind mounts, uid mapping and volume drivers all behave differently.
- The relay must carry TLS, authenticate more than a loopback user, or publish on a non-loopback interface.
- Replicas become a requirement. That needs a shared-state design first, not a Compose change.
- A registry, CI or signed-image pipeline becomes available. The tag scheme should then include the image digest.
- The seven-day rollback window after the state import ends, or the host state diverges from the container. The import and rollback plan must be revisited before then.
- DeepSeek Harness or the operator's password manager changes how model or GitHub credentials are supplied, making the Keychain/1Password path obsolete.
- Named volumes prove unsuitable for the SQLite database, or Docker Desktop file sharing becomes the better option.
