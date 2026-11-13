# 0001 Slack Source over Socket Mode

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** the maintainer, after review of `docs/009-slack.md`
- **Design document:** `docs/009-slack.md` (sections 1-22)

## Context

dsh-superagent has one chat Source, Feishu, and it is the template every later chat Source is measured against: six modules plus a plugin entry, a per-kind configuration schema, a setup probe, a Source part in the Policy with its own admission table, replies through the Outbox, health entries, worker environment variables, and a skill. Slack is the first test of whether that shape generalizes.

The deployment shape forces the transport. dsh-superagent runs next to a person: a laptop, a home machine, or a container with no public ingress. Slack's HTTP Events API requires a public request URL, TLS termination, and signature verification of every request. Socket Mode instead opens an outbound WebSocket from the app to Slack, established with an app-level token (`xapp-`) carrying `connections:write`. Slack states that inbound events over that socket need no verification because the connection is pre-authorised. There is no ingress, no tunnel, no certificate, and no signature code.

The rest of the Slack platform decides the remaining details:

- The official Slack CLI manages apps and manifests and calls the Web API, but it does not stream events, so a Slack Source cannot reuse the `lark-cli` pattern off the shelf.
- Messages are mrkdwn, with no mentions array and no documented mrkdwn-to-text converter, so the Source parses the text itself.
- Threads are ordinary messages carrying `thread_ts`, so there is no thread to poll.
- Socket Mode has no documented offline buffer, so the transport is lossy and recovery must read history.
- `chat.postMessage` has no server-side idempotency key, so outbound delivery can only be at-least-once.
- User ids are only meaningful together with their `team_id`, so the Policy part must store the workspace.

Finally, the existing deployment and setup code special-cases Feishu at several sites: `Deployment.feishu`, the literal `SETUP_FIELDS`, the `SetupPlace` union, `Setup.problem` and `feishuProblem`, `ChannelLinks.feishu`, and the panel and locales. A second chat Source added the same way would touch every one of those sites and make the next Source worse.

## Decision

### Transport and installation

Socket Mode, with static tokens. The app is internal, single-workspace, created from a manifest at `api.slack.com`, and installed by hand. `token_rotation_enabled` is `false`, so the `xoxb-` bot token and the `xapp-` app-level token stay valid until revoked. There is no OAuth redirect, no Marketplace review, and no multi-workspace installation.

Tokens never enter the settings database or the repository. The bridge stores them in one config file with mode `0600`, validates them with `auth.test` and `apps.connections.open`, and never prints them.

### Terminology

Code, configuration, and resource paths say **conversation** for a Slack channel or DM. **Channel** remains the domain's write side, with a `ChannelRef` address. The per-row identifier is `conversationId`, and no configuration key is called `channel`; `chats` and `otherChats` are kept because they read as "chat" to an operator.

### Subscription and admission

The app subscribes broadly and filters locally. The subscribed events are `app_mention`, `message.channels`, `message.groups`, `message.im`, `app_uninstalled`, and `tokens_revoked`. `scope()` has three rows: direct, listed conversation, and other conversation.

The admission table keeps the same cells as Feishu. A DM starts one Thread per message. The bot's own messages and disallowed conversations are dropped before admission. A Trigger is addressed when it mentions the bot or arrives by DM.

### Backfill

Recovery is per conversation, from a cursor in `KV.slack.history`, with five seconds of overlap, pages read oldest-first, thread replies followed, and a fourteen-day ceiling. The cursor advances only after a successful pass; the first sight of a conversation starts at the loop's start time and reads nothing. Backfill is sequential across conversations.

### Replies

`chat.postMessage` with `thread_ts` equal to the Trigger's `thread_ts`, or its `ts` for a top-level message, so every reply lands in a thread and a DM answer stays under its DM. Text is plain mrkdwn, at most 100 words, rejected with the standard rewrite error rather than split. There is no Block Kit, no `chat.update`, and no streaming.

Delivery is at-least-once. No `client_msg_id` is sent: Slack requires a UUID and documents no deduplication, so the receipt id would be only a label. One send is in flight globally. Deep links are built from the workspace URL returned by `auth.test`.

### Identities and Policy

The Slack Policy part stores `teamId`, then `allowed` user ids (`U…` or Enterprise Grid `W…`), a `syncConversation`, and a bot list. The roster syncs through `conversations.members` and `users.info`; the bot learns its identity from `auth.test`, including `bot_id`. A `team_id` mismatch is a health error, because a user id is meaningless outside its workspace. Email is never requested, and Slack identities are never mapped to Feishu or GitHub identities.

### Supervision and packaging

Slack lives in `src/sources/slack*.ts`, mirroring the Feishu module split. The bridge is a separate entry, `src/sources/slack-bridge.ts`, shipped as the `slack-bridge` bin. The Source entry is exported as `./slack-watch`, and the plugin id `dsh-superagent-slack` is added to `cordis.patch.yml` with `disabled: true`. The `@slack/socket-mode` and `@slack/web-api` dependencies belong to the bridge entry only.

Before the Slack loop is written, the spawn, readiness, restart, backoff, health, and stop logic in `src/sources/feishu-loops.ts` is extracted into a shared `supervise` helper, and the Feishu consumer is migrated to it with its argv, readiness line, and error text unchanged.

### Phase 0

Before any Slack code, deployment, setup, context, panel, and link handling are generalized from Feishu-specific fields to per-source slots keyed by kind. Feishu's `history` health entry is renamed `history:feishu` in the same change. Slack then registers its setup and health through the generic path.

### Deferred

Images and files are v1.1. Block Kit, streaming and progress messages, reactions, slash commands, interactivity, multi-workspace OAuth, Enterprise Grid org-wide installs, message edits and deletions as triggers, and backfill older than fourteen days are out of v1.

## Consequences

### What becomes harder

- **A scope change means a reinstall.** Adding a scope requires reinstalling the app, which issues a new bot token unless rotation is in use. The operator copies the token, re-runs `slack-bridge auth`, and restarts. A `missing_scope` error is surfaced with the missing scope named rather than retried silently.
- **Recovery is bounded, not guaranteed.** Socket Mode may lose events while no socket is open, and the backfill window is a ceiling of fourteen days. A longer outage is recovered only as far as the ceiling allows, and a gap inside the window is recovered through history rather than through replay.
- **Replies may duplicate once.** A crash between Slack accepting a message and the Outbox settling the receipt sends the reply again on restart. This is accepted; reading the thread back before every retry is not.
- **One active chat Source at a time is the working assumption.** Slack and Feishu may both be configured, but the design does not assume they are both enabled, and running two chat Sources at once is untested. Prompts, health, and the admission view assume one place a person talks to the agent.
- **Phase 0 changes shared behaviour.** Renaming the Feishu health entry and replacing the fixed setup tables touches running installations. The Feishu tests remain the guard, but their fixtures and payloads need mechanical edits for the per-kind profile.
- **Secrets live in one more place.** The token file is outside the settings database and the repository, but it is a file on the operator's machine that must be protected and backed up deliberately.

### Debt this creates

- The per-Channel word limit, the link builders, the read resources, setup, and the prompt skill all need Slack-shaped generality. Phase 0 pays the setup part up front; the rest lands with the implementation.
- The panel must render a second Source card, its health entries, its setup problem, and its conversation labels through the generic path rather than through Feishu branches.
- The documentation set (`002`, `004`, `005`, `006`, `007`) gains Slack rows and sections during the implementation phases; `docs/009-slack.md` lists the intended edits but does not apply them.

## Alternatives considered and rejected

- **HTTP Events API with a public URL and signature verification.** Rejected: it requires an ingress, TLS, and a tunnel or relay on a machine that deliberately has none, plus replay protection and request signing. It buys nothing Socket Mode does not provide for a single internal app.
- **Polling only, with `conversations.history` on a timer.** Rejected as the transport: mentions would arrive late, tier-3 rate limits bound the polling rate, and the same pages would be read repeatedly. History polling is kept only as the backfill of last resort.
- **A narrow `app_mention` subscription plus thread polling.** Rejected: thread replies are delivered as ordinary message events, so polling each thread would multiply API calls and still miss messages in channels listed for all messages. A broad subscription costs one fixed scope set and moves the filtering into code that can be tested.
- **Block Kit, `chat.update`, or a streaming reply surface.** Rejected: v1 replies are plain text under a 100-word limit, and blocks would need a second renderer and input parsing. `chat.update` only edits the bot's own messages, and progress streaming is out of scope.
- **Vendoring the official Slack CLI or building on Bolt.** Rejected: the Slack CLI does not stream events, and Bolt brings its own receiver and app lifecycle. A thin `slack-bridge` keeps the Socket Mode and Web API libraries out of the Source's runtime, gives the tests a real process to fake, and owns the token file.
- **Per-source special-casing instead of generalizing deployment and setup.** Rejected: it would add a third set of Feishu-shaped branches across deployment, setup, context, panel, and locales, and make the next Source worse. The Phase 0 slots cost one refactor now and are reused by every later Source.
- **Multi-workspace distribution through OAuth.** Rejected: one internal app in one workspace, static tokens, no redirect. Grid `W…` ids are accepted in the schema, but an org-wide installation is not supported.
- **Storing the Slack tokens in the settings database.** Rejected: secret material would reach the panel, backups, and exports. The bridge config file is outside both and is the only place the tokens are read.
- **Mapping Slack identities to Feishu or GitHub accounts by email.** Rejected: the domain forbids mapping identities across Sources. A Slack user is a Slack id plus its `team_id`, and the allowed list is that Source's own part of the Policy.
