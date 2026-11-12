# 009 Slack Source

This document designs a Slack Source for dsh-superagent. It uses the terms in [001 Domain model](001-domain.md) and [002 Authorization](002-authorization.md), the deployment procedure in [006 Deployment](006-deployment.md), and the components in [007 Architecture](007-architecture.md). The Feishu Source is the template: the same six responsibilities, the same configuration shape, the same admission table, and the same rule that a Source only translates events and never decides authority.

The change is documentation only. `docs/009-slack.md`, `docs/adr/0001-slack-source.md`, and the glossary rows in [001 Domain model](001-domain.md) describe work that follows review. No Slack code exists yet.

Slack platform statements cite the official documentation at `docs.slack.dev`. Where Slack documents no behaviour, the text says so and names the page that is silent.

## 1. Scope

Version 1 reaches parity with the Feishu Source except for images and files.

| Capability | v1 | Notes |
| --- | --- | --- |
| @mentions in listed conversations | yes | `app_mention` and mention tokens in `message.*` events |
| All messages in listed conversations | yes | `listen: 'all'`, admitted as inferred input |
| Direct messages | yes | each DM message starts its own Thread |
| Mentions in other conversations | yes | `otherChats: 'mentions'`, local filtering only |
| Thread-context reading | yes | `conversations.replies`, plus preceding channel messages for top-level messages |
| Thread replies | yes | `chat.postMessage` with `thread_ts` |
| Membership sync | yes | `conversations.members` plus `users.info` |
| Deep links | yes | archive URL from the workspace URL; `chat.getPermalink` is the fallback |
| Health reporting | yes | `slack` and `history:slack` entries |
| Worker environment | yes | `DSH_SUPERAGENT_SLACK_BOT`, `DSH_SUPERAGENT_SLACK_CONVERSATION` |
| Images and files | v1.1 | message events carry `files[]`, out of scope here |

One Slack workspace is configured. Slack and Feishu may both be configured, but only one is expected to be enabled in practice; the design does not assume it.

## 2. What Slack makes different

### 2.1 Transport: Socket Mode

Slack offers two event transports. The HTTP Events API requires a public request URL and signature verification; Socket Mode opens an outbound WebSocket instead, which fits a Source that runs behind a personal machine, a NAT, or a container without an ingress. Socket Mode also removes signature verification entirely, because the connection is established with an app-level token and Slack states that "there's no need to verify or validate inbound events, because you're receiving the events over a pre-authorised connection" ([Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)).

The connection procedure is:

1. The app has Socket Mode enabled and an app-level token beginning `xapp-` with the `connections:write` scope.
2. `POST apps.connections.open` with that token returns a short-lived `wss://` URL ([`apps.connections.open`](https://docs.slack.dev/reference/methods/apps.connections.open)).
3. Slack sends frames as JSON objects. An event arrives as `{ "type": "events_api", "envelope_id": "…", "payload": <the event_callback body> }`; the app acknowledges it by sending `{ "envelope_id": "…" }` back on the socket ([Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)).
4. Slack closes and reissues connections roughly hourly, with `disconnect` frames whose `reason` is `warning` (about ten seconds before), `refresh_requested`, or `link_disabled`. The page says to expect connection refreshes "once every few hours". Up to ten WebSocket connections may be open at once.
5. Slack documents acknowledgement as the condition for retrying an event ("Your app still needs to acknowledge receiving each event so that Slack knows whether to retry"). It does not document offline buffering while no socket is open; the design therefore treats the transport as lossy and relies on the backfill of section 12.

### 2.2 No CLI streams Slack events

The official Slack CLI manages apps and manifests and calls the Web API; it does not stream events (see [Slack CLI](https://docs.slack.dev/tools/slack-cli/), whose reference covers app development and deployment, not event consumption). The supported building blocks are the `@slack/socket-mode` and `@slack/web-api` packages (`3.2.0` and `8.3.0` at the time of writing), with `@slack/bolt` (`5.1.0`) as a higher-level alternative. Socket Mode documentation explicitly allows implementing the protocol yourself.

The Feishu Source consumes a CLI (`lark-cli`) over a process boundary. Slack has no equivalent, so this design builds one: `slack-bridge`, shipped by this package. The Source talks to it through `Commands`, exactly as it talks to `lark-cli`. Section 13 specifies the contract.

### 2.3 Tokens and installation

| Token | Prefix | Scope | Lifetime |
| --- | --- | --- | --- |
| Bot token | `xoxb-` | one installation, acts as the bot user | long-lived unless token rotation is enabled |
| App-level token | `xapp-` | app-wide, used for Socket Mode | long-lived |

Installation is a manual step at `api.slack.com`: create an internal app from a manifest, install it into the workspace, and copy the bot token. There is no OAuth redirect and no Slack review, because the app is not distributed. A scope change requires reinstalling the app, which issues a new bot token unless rotation is in use ([Tokens](https://docs.slack.dev/authentication/tokens), [Scopes](https://docs.slack.dev/reference/scopes)). The design sets `token_rotation_enabled: false` so that tokens stay static; the operator records the installation date and the account that installed the app, because the app is tied to that installation.

Socket Mode apps cannot be listed in the Slack Marketplace; this is irrelevant for an internal app.

### 2.4 Events, text, and threads

The app subscribes to a fixed broad set and filters locally:

| Event | Why it is subscribed |
| --- | --- |
| `app_mention` | mentions in conversations the bot is a member of; never fires for DMs ([`app_mention`](https://docs.slack.dev/reference/events/app_mention)) |
| `message.channels` | public channels the bot is in |
| `message.groups` | private channels the bot is invited to |
| `message.im` | direct messages |
| `app_uninstalled` | the app was removed; events stop |
| `tokens_revoked` | tokens were revoked; the socket and API calls fail |

Slack delivers thread replies as ordinary `message.*` events carrying `thread_ts`; there is no thread to poll. `message_changed` and `message_deleted` are delivered for edits and deletions but the design ignores them as triggers; a context read shows the current text through `conversations.replies` ([`message` event](https://docs.slack.dev/reference/events/message)).

Bot messages carry `bot_id` and `bot_profile` and usually no `user`. Subtypes include `bot_message`, `message_changed`, `message_deleted`, `thread_broadcast`, and `file_share`. Slack states that "not all message subtypes are deliverable in the Events API" ([`message` event](https://docs.slack.dev/reference/events/message)).

Text is mrkdwn: mentions are `<@U012AB3CD>`, channel links are `<#C123ABC456|general>`, links are `<https://example.com|label>`, special mentions are `<!here>`, `<!channel>`, and `<!everyone>`, and dates are `<!date^…|fallback>`. `&`, `<`, and `>` are HTML-escaped ([Formatting text](https://docs.slack.dev/messaging/formatting-message-text)). A message has no mentions array and Slack documents no mrkdwn-to-plain-text converter, so the Source parses the text itself (section 7.4).

A Thread is identified by `thread_ts`: absent means a top-level message, equal to `ts` means the thread parent, different from `ts` means a reply. `conversations.replies` returns the parent and the replies, earliest first, with cursor pagination ([`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies)).

### 2.5 Outbound limits

| Fact | Consequence |
| --- | --- |
| `text` is best under 4,000 characters; longer messages are truncated above 40,000 with a `message_truncated` warning | the 100-word rule is far below the limit; no splitting logic is needed |
| `chat.postMessage` runs on the special tier, roughly one message per channel per second ([Rate limits](https://docs.slack.dev/apis/web-api/rate-limits)) | one send at a time globally, as the Outbox already does |
| `conversations.history`, `conversations.replies`, and `conversations.members` are tier 3 or 4 (50+ or 100+ per minute) | backfill pages sequentially with a small page size |
| HTTP 429 carries `Retry-After` | the bridge waits for it, bounded, and the Source retries on error only |
| Slack provides no server-side idempotency key | outbound delivery is at-least-once (section 10.4) |
| `chat.update` only updates the bot's own messages and rejects `text` over 4,000 characters with `msg_too_long` | not used in v1 |

### 2.6 Identity

Slack user IDs begin `U`; on Enterprise Grid they may begin `W` and are enterprise-scoped ([User object](https://docs.slack.dev/reference/objects/user-object)). A workspace-scoped ID is only meaningful together with its `team_id`, so the policy part stores both (section 9). The bot learns its own identity from `auth.test`, which returns `url`, `team`, `team_id`, `user_id`, and `bot_id` ([`auth.test`](https://docs.slack.dev/reference/methods/auth.test)). Email addresses are available only with `users:read.email`; the design does not request it and never maps a Slack identity to a Feishu or GitHub identity, which is a hard rule of the domain ([001 Domain model](001-domain.md)).

## 3. Terminology: conversation, thread, and channel

Slack calls both a public channel and a direct-message container a "conversation" in its API (`conversations.*`). dsh-superagent already uses "Channel" for the write side: the place a reply is posted. Using "channel" for both would make every sentence ambiguous, so:

- Code, configuration, and resource paths use **conversation** for a Slack channel or DM.
- A **Channel** remains the outbound write side of the domain, with a `ChannelRef` address.
- UI labels may say "channel" or "频道" where the operator is choosing a Slack channel; the field and the stored value are still `conversationId`.

| Slack term | This design's name | Domain concept |
| --- | --- | --- |
| workspace | team, `team_id` | the tenant of the installation |
| public or private channel | conversation, `conversationId` (`C…` or `G…`) | a receiving scope and an admission row |
| direct message | conversation with `direct: 'true'` | a receiving scope and the `direct` admission row |
| message | message, `ts` | one Trigger |
| thread (`thread_ts`) | thread, `slack:<conversation>:<thread_ts>` | the Thread a Trigger belongs to |
| reply posted with `thread_ts` | reply | a Channel address |

The configuration keeps the ratified key names `chats` and `otherChats` because they read as "chat" to an operator and match the Feishu settings; the per-row identifier is `conversationId`. No configuration key is called `channel`.

## 4. Modules

The Feishu Source splits into six modules plus a plugin entry. The Slack Source mirrors that split. All paths are relative to the repository root.

| Path | Responsibility | Key exports |
| --- | --- | --- |
| `src/sources/slack.ts` | Source kind, configuration schema, fields, scope, channel wiring, policy, environment, plugin entry. Imports the other modules and assembles them. | `SlackConfigSchema`, `SlackConfig`, `slackKind`, `slackSettings(sources)`, `name`, `inject`, `apply` |
| `src/sources/slack-trigger.ts` | Event envelope validation, translation to a Trigger, deterministic ids, mrkdwn-to-text, senders, subtypes. | `SOURCE`, `SlackEventSchema`, `slackChannel`, `slackThreadId`, `slackTriggerId`, `slackTrigger`, `SlackRef`, `slackRef`, `slackParent`, `mrkdwnText` |
| `src/sources/slack-loop.ts` | The Socket Mode stream, readiness, restart, and the per-conversation backfill loop; conversation labels. | `runSlack`, `watch`, `backfillLoop`, `backfillConversation`, `refreshConversationNames`, `available` |
| `src/sources/slack-channel.ts` | Outbound replies through the bridge, error mapping, and deep links. | `sendSlack`, `slackLink`, `slackGone` |
| `src/sources/slack-read.ts` | Thread context reads and the `slack/<trigger-id>/…` resources. | `slackThreadContext`, `slackRead`, `slackReferences` |
| `src/sources/slack-bridge.ts` | The `slack-bridge` CLI: `listen`, `api`, `auth`; token storage; Socket Mode and Web API calls. | `main(argv, io)`, `loadConfig`, `saveConfig`, `listen`, `api`, `auth` |

The plugin entry follows `src/sources/feishu.ts`: `export const name = 'dsh-superagent-slack'`, `export const inject = ['orchestrator']`, and an `apply(ctx)` that registers the kind and starts `runSlack(sourceContext(host, slackKind), signal)` in an effect that aborts and awaits on dispose.

The bridge is part of the same package but not part of the Source's import graph: `src/sources/slack.ts` never imports `slack-bridge.ts`, and `@slack/socket-mode` and `@slack/web-api` are dependencies of the bridge entry only. The package gains a `bin` entry `slack-bridge` pointing at `lib/slack-bridge.js`, and `tsdown.config.ts` gains an entry `'slack-bridge': 'src/sources/slack-bridge.ts'`. The Source entry is exported as `./slack-watch` and built as `'slack-watch': 'src/sources/slack.ts'`; `cordis.patch.yml` gains the plugin id `dsh-superagent-slack`, `name: dsh-superagent/slack-watch`, and `disabled: true`. These are implementation steps; this document does not apply them.

### 4.1 Rows the implementation adds to 007 Architecture

[007 Architecture](007-architecture.md) is the component map and the documentation test checks that it lists every file under `src/` and every test. The implementation adds these rows; this document does not edit 007.

Modules table:

| Path | Responsibility |
| --- | --- |
| `src/sources/slack.ts` | Slack Source kind: configuration, fields, scope, Channel, thread context, Policy part, environment, plugin entry. |
| `src/sources/slack-trigger.ts` | Translates Slack Socket Mode event envelopes into Triggers; deterministic Trigger and Thread ids; mrkdwn to text. |
| `src/sources/slack-loop.ts` | Runs the `slack-bridge listen` consumer, its restart and health, and the per-conversation backfill and label loops. |
| `src/sources/slack-channel.ts` | Sends replies through `chat.postMessage` and builds Slack archive links. |
| `src/sources/slack-read.ts` | Reads Slack thread context and `slack/` resources for assessments and the Executor. |
| `src/sources/slack-bridge.ts` | The `slack-bridge` CLI: Socket Mode listener, Web API passthrough, and token configuration. |

Tests table:

| Test | Covers |
| --- | --- |
| `tests/slack-trigger.spec.ts` | Event translation, self-echo, bot senders, subtypes, deterministic ids, mrkdwn to text. |
| `tests/slack-read.spec.ts` | Thread context parts, pagination, the top-level fallback, edited text. |
| `tests/slack-channel.spec.ts` | Reply shape, `thread_ts`, error mapping, links. |
| `tests/slack.spec.ts` | Fake bridge: readiness, event stream, restart and backoff, health, backfill, stop. |
| `tests/slack-bridge.spec.ts` | Bridge argv, config permissions, `auth`, `api` passthrough, exit codes, signals. |

## 5. The Source kind

`slackKind` has the shape of every other kind ([007 Architecture](007-architecture.md)). The intended shape is:

```ts
export const slackKind: SourceKind<SlackConfig> = {
  kind: 'slack',
  title: { zh: 'Slack', en: 'Slack' },
  description: {
    zh: '接收这些会话里提到机器人的消息；列出全部消息的会话里也接收其余消息。',
    en: 'Receives messages that mention the bot in these conversations, and the remaining messages in conversations listed for all messages.',
  },
  schema: SlackConfigSchema,
  fields: [
    { key: 'cli', label: { zh: 'slack-bridge 路径', en: 'slack-bridge path' }, type: 'text', hint: { … } },
    { key: 'chats', type: 'rows', label: …, columns: [
      { key: 'conversationId', label: 'Conversation', type: 'text', pattern: /^[CG][A-Z0-9]{5,}$/, choose: true, refresh: true },
      { key: 'listen', label: 'Listen', type: 'select', options: [{ value: 'mentions', … }, { value: 'all', … }] },
    ] },
    { key: 'otherChats', type: 'select', options: ['none', 'mentions'] },
    { key: 'directMessages', type: 'switch' },
    { key: 'readPageSize', type: 'number', min: 10, max: 100, advanced: true },
    { key: 'backfillDays', type: 'number', min: 1, max: 14, advanced: true },
  ],
  health: ['slack', 'history:slack'],
  facts: deployment => { … },
  scope: ({ meta }, config) => { … },
  channel: { allowed, send: sendSlack, link: slackLink, words: 100 },
  threadContext: slackThreadContext,
  find: query => ({ threads: [], terms: slackTerms(query) }),
  repliesTo: trigger => { … },
  policy: { … },
  environment: { variables: […], values: input => ({ … }) },
  refreshLabels: (host, signal) => refreshConversationNames(sourceContext(host, slackKind), signal),
}
```

Each member in turn.

**`facts`** reads the resolved installation from the deployment profile and renders the bot name and workspace for the Settings panel, localized like the Feishu facts: `{ bot: { zh: \`当前机器人 ${name}\`, en: \`Current bot ${name}\` } }`.

**`health`** declares `slack` for the bridge and the socket, and `history:slack` for the backfill. The generic name `history` is already claimed by the Feishu kind; two registered kinds cannot claim one health entry, so Phase 0 renames Feishu's entry to `history:feishu` as part of the per-source slot work (section 15). [006 Deployment](006-deployment.md) and the panel locales follow.

**`scope`** receives the event's meta and decides whether the Source listens and whether it observes every message in that scope. It is the only place that filters conversations (section 8).

**`channel.words`** is new on `SourceChannel`: the hard word limit for replies in that Channel, `100` for Slack and Feishu, absent for GitHub. The Outbox applies it to every chat Source instead of testing for `feishu` (section 18).

**`find`** parses Slack message links so panel search can find a Trigger by URL. A link is `https://<workspace>.slack.com/archives/<conversation>/p<ts without dot>`; the parser converts `p1712345678000100` back to `1712345678.000100` and yields the term `slack:<conversation>:<ts>`, which is the Trigger id. A missing link yields no terms; Thread search stays empty, as it does for Feishu.

**`repliesTo`** maps a reply to the Trigger that started its Thread: when `meta.thread_ts` is a string different from `meta.ts`, the id is `slackTriggerId(conversation, thread_ts)`, otherwise `undefined`.

**`refreshLabels`** fills the conversation names shown in settings and the admission table. Slack event payloads carry no conversation name, so the loop stores `KV.sources.labels('slack')` as it reads `conversations.info` during backfill; `refreshLabels` re-reads the named configured conversations and drops labels for conversations that no longer exist.

## 6. Configuration

```ts
const ConversationSchema = z.object({
  conversationId: z.string().regex(/^[CG][A-Z0-9]{5,}$/),
  name: z.string().max(60).optional(),
  listen: z.enum(['mentions', 'all']),
}).strict()

export const SlackConfigSchema = z.object({
  cli: z.string().trim().default(''),
  chats: z.array(ConversationSchema).default([]),
  otherChats: z.enum(['none', 'mentions']).default('none'),
  directMessages: z.boolean().default(true),
  readPageSize: z.number().int().min(10).max(100).default(50),
  backfillDays: z.number().int().min(1).max(14).default(14),
}).strict()
```

`chats` is de-duplicated by `conversationId` before use. `cli` is the path of the `slack-bridge` executable; it is empty until the operator sets it, and the Source reports a paused health state until it is set and the bridge resolves. Unlike Feishu, the bridge ships with the package, so the operator can also set it to `slack-bridge` and let the worker PATH shim resolve it.

A stored configuration is:

```json
{
  "sources": {
    "slack": {
      "enabled": true,
      "config": {
        "cli": "/Users/me/.local/bin/slack-bridge",
        "chats": [
          { "conversationId": "C0123ABCD", "name": "general", "listen": "all" },
          { "conversationId": "C0456EFGH", "listen": "mentions" }
        ],
        "otherChats": "mentions",
        "directMessages": true
      }
    }
  }
}
```

The configuration is a listening policy, not a permission boundary. Slack delivers every `message.channels` and `message.groups` event for conversations the app is in, regardless of `listen`, and `app_mention` for any conversation the bot is a member of. "Mentions" means the Source drops unaddressed messages locally, so `scope` reports `observed: false` and the admission table sees only addressed messages in that row. Authority still comes from the Policy (section 8); an operator who wants a conversation to be unable to make requests removes it from `chats` and sets `otherChats: 'none'`.

| Configuration | Slack event | Filtered by |
| --- | --- | --- |
| listed, `listen: 'all'` | `message.channels` / `message.groups` | nothing: every message is a Trigger, unaddressed ones are inferred |
| listed, `listen: 'mentions'` | `app_mention`, plus mention messages in `message.*` | `scope`: unaddressed messages are dropped |
| other conversation, `otherChats: 'mentions'` | `app_mention` | `scope`: only addressed messages are listened to |
| direct message | `message.im` | `scope`: the DM row |
| any conversation, bot's own messages | `message.*` from the bot | translation: self-echo is dropped |
| edited or deleted message | `message_changed`, `message_deleted` | translation: ignored as a trigger |

## 7. Events and Trigger translation

### 7.1 The stream

`slack-bridge listen` prints every Socket Mode frame as one JSON line on standard output and announces readiness on standard error (section 13). The Source keeps one consumer per installation. It passes the line through a schema:

```ts
const EventSchema = z.object({
  type: z.literal('events_api'),
  envelope_id: z.string(),
  payload: z.object({
    team_id: z.string(),
    event_id: z.string().optional(),
    event: z.object({
      type: z.string(),
      subtype: z.string().optional(),
      user: z.string().optional(),
      bot_id: z.string().optional(),
      text: z.string().optional(),
      ts: z.string(),
      thread_ts: z.string().optional(),
      channel: z.string(),
      channel_type: z.string().optional(),
      hidden: z.boolean().optional(),
      deleted_ts: z.string().optional(),
      files: z.array(z.unknown()).optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough()
```

Frames whose `type` is not `events_api` (`hello`, `disconnect`, `goodbye`) are read for diagnostics and ignored as events. The bridge acknowledges every event before printing it, so acknowledgement latency is the bridge's concern and not the Source's.

### 7.2 Which events become Triggers

| Event | Action |
| --- | --- |
| `app_mention` | Trigger, `addressed: 'mention'`; the event carries `thread_ts` when the mention is a thread reply |
| `message.channels`, `message.groups`, `message.im` | Trigger; `addressed` is `direct` for `message.im`, `mention` when the text mentions the bot, otherwise absent |
| `message` with subtype `message_changed` or `message_deleted` | ignored |
| `message` with subtype `bot_message` | Trigger when the sender is a bot other than this one (section 7.3) |
| `message` with subtype `thread_broadcast` | Trigger; it has `thread_ts` and belongs to the existing Thread |
| `app_uninstalled` | health error; the consumer keeps retrying but the operator must reinstall |
| `tokens_revoked` | health error when the revoked token list includes the bot's `user_id` |

DMs never produce `app_mention`, which is why `message.im` is mandatory ([`app_mention`](https://docs.slack.dev/reference/events/app_mention)). A mention in a conversation the bot is not in produces no event at all; the user must invite the app, which then produces an `app_mention` for the invite.

### 7.3 Translation rules

The translation function takes the event, the bot identity from `auth.test`, and the profile:

```ts
export function slackTrigger(event: SlackEvent, bot: SlackIdentity, profile: SlackProfile): Trigger | undefined
```

It returns `undefined`, meaning "not a Trigger", in these cases:

- The event is one of the edit/delete subtypes.
- The sender is this bot: `event.bot_id === bot.botId` or `event.user === bot.userId`. This drops the bot's own replies and avoids echo loops.
- The conversation or direct-message flag is outside what the Source listens to. `scope` makes that decision; translation takes the same `scope` result and stops before building a Trigger.
- `event.hidden === true`, a Slack marker for messages the workspace hides.

Otherwise it builds:

| Field | Value |
| --- | --- |
| `id` | `key('slack', '<conversation>:<ts>')` |
| `source` | `'slack'` |
| `threads` | `[{ source: 'slack', id: slackThreadId(conversation, thread_ts, ts) }]` |
| `actor` | `{ id: event.user ?? event.bot_id }`; bot senders carry `bot_id` and no `user` |
| `human` | `true` when `event.user` is present and `event.bot_id` is absent |
| `addressed` | `'direct'` for DMs; `'mention'` for `app_mention` or a mention token matching the bot; otherwise absent |
| `at` | `new Date(Number(ts) * 1000).toISOString()` |
| `text` | `mrkdwnText(event.text ?? '')`, with mention IDs replaced when the name cache knows them |
| `channel` | `slackChannel(conversation, ts, { threadTs, direct })` |
| `url` | the archive URL, built from the workspace URL and the message coordinates |
| `meta` | `{ conversation, ts, threadTs?, direct: 'true'?, mentioned, eventId? }` |

The ids are stable across restarts:

```ts
export const slackTriggerId = (conversation: string, ts: string): string => key('slack', `${conversation}:${ts}`)
export const slackThreadId = (conversation: string, threadTs: string | undefined, ts: string): string =>
  `${conversation}:${threadTs ?? ts}`
export const slackChannel = (conversation: string, ts: string, options: { threadTs?: string; direct?: boolean } = {}): ChannelRef => ({
  source: 'slack',
  thread: `slack:${conversation}`,
  address: {
    conversation,
    ts,
    ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
    ...(options.direct ? { direct: 'true' } : {}),
  },
})
```

A Trigger id contains the conversation. Two messages with the same timestamp in different conversations are different Triggers, and a reply and its parent are different Triggers in one Thread. The `ThreadRef.id` keeps the Feishu convention `<conversation>:<root ts>`; `threadKey` adds the `slack:` prefix.

Restarts must not replay events. The Engine's intake returns `'duplicate'` for a Trigger id that is already stored, and Socket Mode redelivery after a missing acknowledgement carries the same message, hence the same id. Backfill keeps a per-conversation cursor (section 12). The combination means a crash and restart neither loses a message that backfill covers nor re-asks the agent about one it has seen.

### 7.4 mrkdwn to text

Slack has no documented converter, so the Source parses. The rules are deliberately small and lossless enough for an assessment:

| Input | Output |
| --- | --- |
| `<@U012AB3CD>` | `@name` when the cached roster knows the id, otherwise `@U012AB3CD` |
| `<#C123ABC456\|general>` | `#general` |
| `<#C123ABC456>` | `#C123ABC456` |
| `<https://example.com\|label>` | `label (https://example.com)` |
| `<https://example.com>` | `https://example.com` |
| `<!here>`, `<!channel>`, `<!everyone>` | `@here`, `@channel`, `@everyone` |
| `<!date^1712345678^{date_short}\|May 5, 2024>` | `May 5, 2024` (the fallback) |
| `&amp;`, `&lt;`, `&gt;` | `&`, `<`, `>` |

Mentions that cannot be resolved stay as IDs rather than be dropped, so an assessment can still see that someone was addressed. The name cache is `KV.slack.people`, filled by roster sync and by context reads. Asterisks, underscores, and tildes are left alone: they are how Slack renders emphasis, and the assessment reads them without harm.

Outbound text is not escaped or converted. The agent writes plain sentences, `chat.postMessage` renders them as mrkdwn, and the 100-word rule keeps them short. The prompts do not ask the agent to use Slack syntax.

## 8. Receiving scope and admission

`scope` has three rows, exactly as Feishu does. For an event meta `{ conversation, direct }`:

| Row | Condition | `listened` | `observed` |
| --- | --- | --- | --- |
| direct | `direct === true` and `directMessages` | yes | no |
| listed conversation | `chats` contains `conversation` | yes | `listen === 'all'` |
| other conversation | `otherChats === 'mentions'` | yes | no |
| refused | otherwise | no, with a reason | n/a |

The reason codes are `direct_messages_not_allowed` and `conversation_not_allowed`, mirroring `direct_messages_not_allowed` and `chat_not_allowed` in Feishu. `channel.allowed` re-derives the meta from the Channel address and asks the same function, so the Outbox drops a reply when the conversation was removed from the configuration.

The admission table then looks like this, with the same cells as Feishu ([002 Authorization](002-authorization.md)):

| Row | On the list, not addressing the agent | Not on the list, addressing the agent | Not on the list, not addressing the agent |
| --- | --- | --- | --- |
| listed conversation, `listen: 'all'` | inferred by default; `listedUnaddressed` is on | explicit | inferred by default; `unlistedUnaddressed` is on |
| listed conversation, `listen: 'mentions'` | ignored; the Source does not receive it | explicit | ignored |
| other conversation, `otherChats: 'mentions'` | not received | explicit; `unlistedAddressed` is on | not received |
| direct message | not applicable: a DM always addresses the agent | explicit; `unlistedAddressed` is on | not applicable |

`rows(stored)` returns the listed conversations by `conversationId`, the `other` row, and the `direct` row, with localized labels like the Feishu rows. The `explicit` sentence reads: "Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting."

Two consequences are worth stating because an operator may expect otherwise:

- A mention in an unlisted conversation is only delivered when the bot is a member of that conversation. `otherChats: 'mentions'` does not let the bot read conversations it is not in.
- A DM is always addressed, so the DM row has no "not addressing" cell. Turning `directMessages` off removes the row from the Source entirely; it does not make DMs unaddressed requests.

## 9. Policy and roster sync

The Source's part of the Policy is keyed by `slack` and stores the workspace it was written for:

```ts
const PolicySchema = z.object({
  teamId: z.string().regex(/^T[A-Z0-9]{5,}$/).or(z.literal('')).default(''),
  allowed: z.array(z.object({ id: z.string().regex(/^[UW][A-Z0-9]{5,}$/), name: z.string().max(100).optional() }).strict())
    .default([]),
  syncConversation: z.string().regex(/^[CG][A-Z0-9]{5,}$/).or(z.literal('')).default(''),
  bots: z.array(z.object({ id: z.string().regex(/^[UW][A-Z0-9]{5,}$/), name: z.string().max(100).optional() }).strict())
    .default([]),
}).strict()
```

`allowed` holds Slack user IDs, either `U…` for a workspace member or `W…` for an Enterprise Grid user. `teamId` records which workspace the IDs belong to. On startup the Source compares `team_id` from `auth.test` with the stored `teamId`: on the first run it fills the field, and on a mismatch it reports a health error and refuses Triggers, because a `U…` id is only meaningful inside its workspace. The policy version hashes the whole part, including `teamId`, so re-pointing an installation at another workspace invalidates old Mandates.

`bots` lists other bots whose messages may become requests. Slack bot messages carry `bot_id` and no `user`, so translation uses `bot_id` as the actor id and `human: false`; admission then uses the bot list exactly as Feishu does. The bot's own messages never reach admission.

Roster sync uses the configured `syncConversation`:

1. `conversations.members` with the conversation and a cursor, following pages ([`conversations.members`](https://docs.slack.dev/reference/methods/conversations.members)).
2. `users.info` for each unseen id ([`users.info`](https://docs.slack.dev/reference/methods/users.info)), caching by id in `KV.slack.people`.
3. Keep users where `is_bot` is false and `deleted` is false; the display name is `profile.display_name`, falling back to `real_name`.
4. Build `allowed` preserving the order of people already on the list, then append new members sorted by id. Preserving order matters: the policy version is a hash, and a roster that returns members in another order must not invalidate every Mandate. Feishu has the same rule for the same reason.
5. Write `teamId` from `auth.test`.

A member list larger than one page that cannot be completed (an error mid-page) fails the sync with "Slack returned an incomplete member list" and leaves the stored list untouched, mirroring the Feishu failure. Both calls are tier 4 and are made sequentially.

The `bots` list is edited by hand, like the Feishu one; sync does not add bots, because `conversations.members` returns bots too and adding them automatically would authorise every integration in the channel.

Slack identities are never mapped to Feishu or GitHub identities. The roster writes only Slack ids and display names; no email is requested, and no prompt text links a Slack person to an account elsewhere.

## 10. Replies

### 10.1 Shape

A reply is `chat.postMessage` with three fields:

```ts
{
  channel: address.conversation,
  text: message.text,
  thread_ts: address.thread_ts ?? address.ts,
}
```

No `client_msg_id` is sent: Slack requires a UUID there, while the receipt id is a 32-hex SHA-256 slice, and Slack documents no deduplication. Delivery stays at-least-once (section 10.4).

Every reply goes into a thread. For a top-level message the thread parent is the message itself, so `thread_ts` equals its `ts`; for a thread reply it is the Trigger's `thread_ts`. This is the rule that makes a DM behave like Feishu: each DM message starts its own Thread and the answer is posted under that message (section 16 of the ratified decisions). A top-level channel message starts a Thread the same way, so answers never sprawl into the channel.

There is no Block Kit, no `blocks`, no `markdown_text`, no `chat.update`, and no streaming API in v1. The agent's text is sent as `text` in mrkdwn. Mentioning people is not part of the reply contract; if an agent writes `@someone`, Slack renders the plain text and does not notify them, because a real notification needs `<@U…>` syntax.

### 10.2 The word limit

`SourceChannel.words` is `100` for Slack. The Outbox applies `checkedImText` with that limit to every chat Channel, so a Slack reply is checked exactly like a Feishu reply: rewrite the message, never split it. The error text stays the one in `src/infra/text.ts`, with the limit taken from the Channel instead of the constant.

### 10.3 Errors

`slack-bridge api` prints Slack's response JSON on standard output and exits `0` whenever Slack answered, including `ok: false`; exit `1` is a transport or parse failure, and exit `2` is usage or malformed input. The Source maps the error code:

| Code | Outcome |
| --- | --- |
| `channel_not_found`, `not_in_channel`, `is_archived`, `channel_is_archived` | `gone`: the Channel can never receive this message |
| `msg_too_long`, `invalid_blocks`, `invalid_arguments` | permanent failure: the message is stored as an error; a reply this wrong is a bug |
| `ratelimited` | retryable; the bridge waits for `Retry-After` before returning |
| `invalid_auth`, `token_revoked`, `account_inactive`, `not_authed` | retryable, and the Source reports a health error; the operator must reinstall or restore the token |
| `missing_scope` | permanent, with a health error naming the missing scope |
| anything else | retryable until the Outbox gives up, as for any other Source |

The bridge removes HTTP-level noise: a network failure exits `1` with a diagnostic on standard error, and a JSON body that is not Slack's error shape is treated as a transport failure.

### 10.4 Idempotency

Slack has no server-side idempotency key, so the design accepts at-least-once delivery:

- The Outbox receipt id is deterministic, so a crash and retry produce the same local record.
- Only one reply is in flight globally, as the Outbox already enforces.
- A send is retried only after an error. A send that Slack accepted is never retried, because acceptance means `ok: true`.
- No `client_msg_id` is sent; it would add no deduplication guarantee (section 10.1).

The duplicate risk is a crash between Slack accepting the message and the Outbox settling the receipt. On restart the reply is sent once more, producing two messages with the same text. The window is small, and the alternative, reading the thread back before every retry, costs an API call per send and is not part of v1.

### 10.5 Links

`slackLink` builds `https://<workspace>.slack.com/archives/<conversation>/p<ts without the dot>`, using the `url` from `auth.test` stored in the deployment profile. The label is `{ zh: 'Slack 消息', en: 'Slack message' }`; the link carries `triggerId` when the address has a `ts`. `chat.getPermalink` exists and needs no scope ([`chat.getPermalink`](https://docs.slack.dev/reference/methods/chat.getPermalink)), but it is an API call per link, and the archive URL is the same address Slack prints in its own clients. The fallback for a workspace whose URL is unknown, such as a Grid workspace addressed by a grid URL, is the read resource `slack/<trigger-id>/message` rather than a guessed URL.

## 11. Thread context

The context reader follows the Feishu resource scheme:

```
slack/<trigger-id>/message
slack/<trigger-id>/root
slack/<trigger-id>/parent
slack/<trigger-id>/thread
slack/<trigger-id>/around
```

`SlackRef` is `{ triggerId, conversation, ts, threadTs? }`; `slackRef(trigger)` reads it from the Channel address and `trigger.meta`. Both are defined and exported by `slack-trigger.ts` and imported by `slack-read.ts`, so the ref shape has one owner. Only `thread` and `around` take a cursor.

| Part | Bridge call | Result |
| --- | --- | --- |
| `message` | `conversations.history` with `oldest = latest = ts`, `inclusive: true`, `limit: 1` | one message, or an empty page |
| `root` | `conversations.replies` with `ts = threadTs ?? ts`, `limit: 1` | the thread parent |
| `parent` | `conversations.replies` with `ts = threadTs ?? ts`, `limit: 1` | the parent, for a reply |
| `thread` | `conversations.replies` with `ts = threadTs ?? ts` and the cursor, `limit: readPageSize` | parent and replies, oldest first |
| `around` | `conversations.history` with `latest = ts`, `limit: readPageSize`, then reversed | the messages before a top-level message |

`thread` reports `status: 'no_thread'` when the Trigger has no `thread_ts`: Slack has no thread to read, and the assessment would otherwise see only the message. The Runtime treats `no_thread` like Feishu's `chat_neighbours`: it reads `around` instead, which gives the preceding conversation as context. For a Trigger that is itself a reply, `thread` returns the whole thread; no fallback is needed.

Messages are converted to `ContextMessage` with `id` equal to `ts`, `from` equal to the user id (resolved through the name cache when possible), `at` from the timestamp, `text` from `mrkdwnText`, `bot` when the sender is a bot, `reply_to` equal to `thread_ts` when the message is a reply, and `url` as the archive link. `deleted` messages are reported with their text as Slack returns it; the design does not reconstruct the old text. Edits are naturally visible because reads return the current text; the Source never queries the edit events.

Images are absent in v1: `images` returns no keys and `image` throws "The slack Source has no images", so an assessment that would attach an image gets the Feishu-like behaviour of a text-only context.

## 12. Backfill

Socket Mode does not promise delivery while the consumer is down. There is no "events since X" endpoint, so recovery reads history ([`conversations.history`](https://docs.slack.dev/reference/methods/conversations.history), [`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies)).

- Per-conversation cursor in `KV.slack.history(conversationId)`.
- On first sight of a conversation the cursor is set to the loop's start time and nothing is read. History before installation is not a request to the agent, and reading years of it on first start would flood the gate.
- Later, a pass reads from `cursor - 5 seconds` to the loop start, capped at `now - backfillDays` (default 14, maximum 14). Five seconds of overlap covers a message that arrived while the previous page was being read; the Trigger id makes the overlap harmless.
- The read is `conversations.history` with `oldest` and `latest` and `limit: 200`, newest first. Pages are collected, sorted ascending by `ts`, and emitted oldest-first, so the agent sees a conversation in order even though the API returns it backwards.
- A message with `reply_count > 0` or a `latest_reply` newer than the cursor is followed by `conversations.replies` pages for that thread, also oldest-first. A reply that arrived after its parent but before the cursor window is still read.
- Translation is the same function as for live events. A message that was already a Trigger returns `duplicate` from intake and costs nothing.
- Skipped messages are the bot's own, the edit and delete subtypes, and messages in conversations that `scope` refuses. `message_changed` in history appears as the current text of the message, not as a separate entry.
- The cursor advances to the loop start time only after a successful pass; an error leaves it in place and reports `history:slack`.
- Conversations to backfill are the configured `chats` plus the conversations seen live and stored in `KV.slack.conversations` (with a `direct` flag). Slack offers no way to enumerate DMs, so a DM is only known after its first live event; this is the same limitation the Feishu Source accepts.
- Each pass re-reads the configuration, so a public conversation added to `chats` is joined on the next pass, roughly every 60 seconds, without a restart. A private conversation still needs an invitation and reports `slackNotAMember` until it has one.

Backfill is sequential across conversations. `conversations.history` is tier 3, so a page size of 200 and one conversation at a time stay inside the limit; a 429 is handled by the bridge as in section 10.3.

## 13. The slack-bridge CLI

### 13.1 Why a CLI

The Source already consumes CLI adapters through `Commands`, and the Executor already gets PATH shims for them. A CLI keeps the Socket Mode library out of the Source's runtime, gives the test suite a process it can fake with a shell script, and lets the bridge own the token file, which must never enter the settings database or the repository. `lark-cli` is the precedent; `slack-bridge` is its Slack counterpart.

### 13.2 argv

| Command | Behaviour |
| --- | --- |
| `slack-bridge listen` | Opens a Socket Mode connection, prints every frame as one JSON line on stdout, readiness and diagnostics on stderr. Runs until a signal. |
| `slack-bridge api <method> [json]` | Calls one Web API method with the bot token. `json` is the request body as one argument; omitted means `{}`. |
| `slack-bridge auth` | Reads one JSON object from stdin, validates both tokens, writes the config file. |
| `slack-bridge --version` | Prints the version and exits 0. |

Unknown commands print usage on stderr and exit 2.

### 13.3 Environment

| Variable | Meaning |
| --- | --- |
| `SLACK_BRIDGE_CONFIG` | Path of the config file. Default `$HOME/.slack-dsh-superagent/config.json`. |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | Replace the tokens from the config file. Used by tests and by an operator who keeps tokens in a secret manager. If either is set, the config file is not read. |

The bridge never reads another environment variable for configuration, and the Source passes these through only when it must.

### 13.4 stdout and stderr protocol

`listen` writes only JSON to stdout, one object per line, as received. Frames are passed through unchanged: `hello`, `events_api`, and `disconnect` keep their `type` field. The first line is `{"type":"hello"}` when Slack accepts the connection; the Source treats a `hello` as the readiness signal only after stderr confirms it, because a connection can be accepted and closed immediately.

Readiness is the exact stderr line `[socket] ready`, printed once the first `hello` arrives. The Feishu consumer uses the same pattern with `[event] ready`. After readiness the bridge may print `[socket] reconnecting <reason>` and `[socket] closed <reason>`; it never exits on a reconnectable disconnect, it reopens the connection with backoff. `link_disabled` is not reconnectable: the bridge prints `[socket] disabled` and exits 1, because the app's Socket Mode was turned off in the Slack app settings.

Stdout is never used for diagnostics. A malformed line on stdout is a bug: the Source rejects the line and reports the health detail, it does not crash the loop.

### 13.5 api passthrough

`api` prints Slack's response JSON verbatim on stdout, including `{ "ok": false, "error": "…" }`, and exits `0` whenever Slack answered, whether `ok` is true or false. A transport failure or a response that cannot be parsed prints a human sentence on stderr and exits `1`, with no JSON on stdout; usage errors and malformed input exit `2`. A 429 response causes the bridge to sleep for `Retry-After` seconds, capped at 60, and retry up to twice; the caller sees one response. The cap matters because the Outbox retries every five seconds, and a bridge that blocks for fifteen minutes would stall the reply queue.

`api` does not implement Slack-specific pagination: it calls one method once. Cursor loops live in the Source, where the cursor can be persisted.

### 13.6 auth

`auth` reads exactly one JSON object:

```json
{ "bot_token": "xoxb-…", "app_token": "xapp-…" }
```

Tokens on a command line would leak into the process list and shell history, so they arrive on stdin. The bridge validates the bot token with `auth.test` and the app token with `apps.connections.open` (closing the returned URL immediately), then writes:

```json
{
  "version": 1,
  "bot_token": "xoxb-…",
  "app_token": "xapp-…",
  "team_id": "T0123ABCD",
  "team": "Acme",
  "bot_id": "B0123ABCD",
  "user_id": "U0123ABCD",
  "url": "https://acme.slack.com/",
  "created_at": "2026-11-12T08:00:00.000Z"
}
```

The directory is created `0700` and the file written atomically with mode `0600`; an existing file with wider permissions is rewritten to `0600` on the next `auth`. The bridge prints one JSON line `{ "ok": true, "team": …, "team_id": …, "bot_id": …, "user_id": …, "url": … }`; token values are never printed. A rejected token prints the Slack error code on stderr and exits 1; malformed stdin exits 2. The tokens are not stored in Slack's own config, the settings database, or the repository.

The Source never writes this file. Setup only reads it indirectly, through `api auth.test` with the bridge on PATH.

### 13.7 How the Source calls it

`Commands` gains a Slack accessor in the same style as `lark`:

```ts
async slack(args: string[]): Promise<string> {
  return this.run(this.deployment.sources.slack.cli, args)
}
async slackJson<T>(args: string[], schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await this.slack(args)))
}
```

The listen consumer does not use `Commands.run`, because it is long-lived: the loop spawns the same executable through the subprocess helper and reads stderr and stdout lines, exactly as the Feishu watch loop does.

### 13.8 How tests fake it

Tests write a `fake-slack-bridge` shell script into a temporary directory and point `config.cli` at it, mirroring the fake Feishu consumer in `tests/sources.spec.ts`. Modes are selected by an environment variable or by argv:

| Mode | Script behaviour |
| --- | --- |
| `never` | prints nothing and sleeps |
| `warn` | prints a warning on stderr, then sleeps |
| `ready` | prints `[socket] ready` and sleeps |
| `events` | prints `[socket] ready`, then copies a fixture NDJSON file to stdout, then sleeps |
| `flaky` | exits 1 before readiness |
| `late` | prints readiness after a delay |
| `bad-json` | prints a non-JSON line on stdout after readiness |
| `api-<method>` | prints a canned JSON response and exits 0 (or 1 for a simulated transport failure) |

The fake is a real process, so readiness timeouts, restarts, backoff, and health transitions are tested without network access. `tests/slack-bridge.spec.ts` tests the real bridge only where it needs no Slack connection: argv parsing, config permissions, `auth` validation failure, and the shape of the JSON it prints; the Socket Mode client itself is not unit-tested.

## 14. Supervision

### 14.1 The shared helper

`src/sources/feishu-loops.ts` contains the spawn, readiness, restart, backoff, health, and stop logic for the Feishu event consumer. Slack needs the same logic with different argv, a different readiness line, and a different exit message. Copying it would duplicate the most failure-sensitive code in the Source layer.

Extract it to `src/sources/loop.ts`:

```ts
export interface Consumer {
  /** Name used in health details and in the exit error, for example "Slack socket". */
  name: string
  /** Program and arguments, resolved by the deployment profile. */
  command: string
  args: string[]
  env: Record<string, string>
  /** Readiness line on stderr, for example "[socket] ready". */
  ready: string
  /** Called for each stdout line, in order. Rejections restart the consumer. */
  line: (line: string) => void | Promise<void>
  timeoutMs?: number
}

/** Runs one consumer until the signal aborts: waits for readiness, streams lines sequentially, restarts with backoff. */
export function supervise(ctx: SourceContext, consumer: Consumer, signal: AbortSignal): Promise<void>

/** Delay before a restart: 1 s after the first failure or after a minute of uptime, otherwise double, capped at 60 s. */
export function consumerRetry(previous: number | undefined, ranMs: number): number
```

The helper reproduces the Feishu behaviour exactly:

- Waits for `ctx.ready` and for the enabled check before spawning.
- Spawns with a 1 MiB line limit, strips `worker-bin` from PATH, and sets the environment the caller passes.
- Treats stderr lines that equal `ready` as readiness; a timeout reports `<name> did not become ready within 45 seconds` as the diagnostic and stops the child.
- Handles stdout lines strictly sequentially; a rejected handler restarts the consumer.
- On exit reports `<name> exited (<code>, ready=<bool>): <diagnostic>` and restarts with `consumerRetry`.
- Updates the kind's health entry through `ctx.report`, and stops the child on abort, waiting for it before resolving.

The Feishu watch loop keeps its argv, environment, readiness line `[event] ready`, and the error text, and calls the helper. Its tests keep the same assertions on readiness, restart numbers, and health, so the migration is provable rather than plausible.

### 14.2 The Slack watch loop

`watch` in `slack-loop.ts` calls `supervise` with:

| Field | Value |
| --- | --- |
| `name` | `Slack socket` |
| `command` | the configured `cli` |
| `args` | `['listen']` |
| `env` | the inherited environment plus `SLACK_BRIDGE_CONFIG` when the deployment profile names a non-default file |
| `ready` | `[socket] ready` |
| `line` | parse the envelope; for `events_api`, translate and `ctx.receive`; for `disconnect`, report the reason in the health detail |

The loop reports `slack` as `ready` once readiness is seen, `paused` with `slackBridgeUnset` when `cli` is empty, `paused` with `setupPending` when setup has not resolved an installation, and `error` with `slackTokenRevoked` or `slackAppUninstalled` after the corresponding event or error. It keeps retrying after an auth error with the normal backoff, because a reinstall may fix the token without restarting dsh-superagent; the health detail tells the operator what to do.

The two loops of `runSlack` are `watch` and `backfillLoop`; the Feishu chat-name loop becomes part of `backfillLoop` as `refreshConversationNames`, which reads `conversations.info` for configured and known conversations and stores labels. `runSlack` returns `Promise.allSettled([...])`, the same shape as `runFeishu`.

## 15. Phase 0: deployment and setup slots

### 15.1 The problem

Today a Source is a pair of special cases:

- `Deployment` has `feishu?: FeishuBot`.
- `SETUP_FIELDS` is a literal record with `github` and `feishu` keys.
- `SetupPlace` is `'deployment' | 'github' | 'feishu'`, and `SetupError` looks its place up in a fixed table.
- `Setup` carries `problem` and `feishuProblem`; `SourceContextDeps` passes both; `sourceContextOf` picks the problem whose `place` matches the kind.
- `ChannelLinks` has `feishu`.
- The HTTP layer, the settings view, the client deployment page, and the locales each name Feishu.

Adding Slack as a third special case would touch every one of those sites and make the next Source worse. Phase 0 replaces the cases with slots keyed by kind.

### 15.2 The shape

```ts
/** What a kind needs to resolve its installation from a probe run in the worker environment. */
export interface SourceSetup {
  /** Config keys whose change requires a setup re-check, for example ["cli"]. */
  fields: readonly string[]
  /** Resolves the profile stored in Deployment.sources[kind], or throws SetupError. */
  probe(input: { machine: Machine; config: Record<string, unknown>; run: Probe; signal: AbortSignal }): Promise<unknown>
}

export interface SourceKind<C> {
  // …
  setup?: SourceSetup
}

/** The build-time and run-time profile of one Source installation, validated by its kind. */
export interface Deployment {
  // …machine and github stay: the repository is not a Source slot
  sources: Readonly<Record<string, unknown>>
}
```

`Probe` is `(argv: string[]) => Promise<string>`, matching the existing `workerProbe`: the first element is the program and the rest are its arguments. The probe receives the raw config because it needs `cli`; it returns an opaque profile that only the kind reads. The core stores `Deployment.sources` as an untyped record keyed by kind; each kind validates its own profile, and no core typed accessor is introduced.

The Slack kind's `setup` is:

```ts
setup: {
  fields: ['cli'],
  async probe({ machine, config, run }) {
    const cli = executable('slack-bridge', String(config.cli), …)
    const identity = JSON.parse(await run([cli, 'api', 'auth.test']))
    if (!identity.ok) throw new SetupError('slackAuthFailed', { error: identity.error })
    return { cli, teamId: identity.team_id, team: identity.team, botId: identity.bot_id, userId: identity.user_id, url: identity.url }
  },
}
```

The bridge exits `0` whenever Slack answered, so `run` returns the `ok: false` body and the probe raises the structured setup error itself.

The Feishu kind's `setup` wraps `resolveFeishuBot` unchanged, with `fields: ['cli']`.

### 15.3 What moves

| Site | Before | After |
| --- | --- | --- |
| `src/deployment.ts` | `FeishuBotSchema`, `FeishuBot`, `Deployment.feishu`, `SETUP_FIELDS` | schemas and profiles stay in the kinds; `Deployment.sources` holds profiles; `SETUP_FIELDS` is gone |
| `src/setup.ts` | `SetupPlace` union, fixed `SETUP_PROBLEMS` | `SetupProblem.place` is a kind string, `SETUP_PROBLEMS` gains per-kind codes, `SetupCode` stays a key union |
| `src/app/setup.ts` | `problem`, `feishuProblem`, `checkAccounts` branching on `source:feishu` | `problems: Map<string, SetupProblem>`, a loop over registered kinds, `check()` fails on any enabled kind's problem |
| `src/app/source-context.ts` | `setupProblem`, `feishuProblem`, a `find` on `place` | `problems: ReadonlyMap<string, SetupProblem>`; `problem` is `problems.get(kind.kind)` |
| `src/infra/commands.ts` | `lark()` reads `deployment.feishu` | `lark()` reads `deployment.sources.feishu`; a Slack accessor sits beside it |
| `src/app/runtime.ts`, `src/app/http.ts` | pass `feishuProblem` | pass the map |
| `src/app/views/settings.ts` | `SETUP_FIELDS[instance.id]` | `kind.setup?.fields ?? []` |
| `src/app/views/sources.ts` | `SetupState` carries `problem` and `feishuProblem`; `problemOf` scans them | `SetupState` carries one `problems` map; `problemOf` looks up the kind |
| `src/client/deployment.tsx`, `overview.tsx` | Feishu-specific rows and label keys | iterate the deployment profiles; the "check failed" row is keyed by kind |
| `src/sources/kind.ts` | `ChannelLinks = { repository?, feishu? }` | `ChannelLinks = { repository?: string; sources: Readonly<Record<string, unknown>> }` |
| `src/app/links.ts` | passes `{ feishu }` | passes `{ repository, sources }` |

The HTTP setup payload becomes `problems: Record<string, { code: string; message: string }>`, keyed by kind; no Feishu-specific key remains in state or the panel. A Source card reads its problem from `problems[<kind>]`.

The `setupFields` change-detection function iterates the registered kinds and serializes the named keys, preserving its current JSON-array comparison so that editing a CLI path still restarts the services. A kind without `setup` (GitHub is not a kind, but an experimental Source might be) contributes no fields and no probe.

### 15.4 Migration and compatibility

- Deployment profiles are rebuilt on every start, so no store migration is needed. The state directory keeps its content.
- Stored settings are unchanged: the per-kind `sources.<kind>` record already exists, and the Feishu config keeps its shape.
- The health entry `history` is renamed `history:feishu` in the same change. `SETUP_PROBLEMS` keeps every Feishu code and message; only its `place` becomes the kind string.
- The panel and localizations are updated in the same change: a missing Slack field must render through the generic path, not a Feishu branch.
- `grep -rn "feishuProblem\|SETUP_FIELDS" src/` must return nothing after the change except Feishu's own probe code and health entry.

### 15.5 Acceptance criteria

1. Registering `slackKind` without touching `src/app/setup.ts`, `src/deployment.ts`, `src/app/http.ts`, or the client produces a Settings card, a setup probe, health entries, and a deployment profile.
2. A failing Slack probe pauses only the Slack Source; the rest of the service keeps running, as a failing Feishu probe does today.
3. Feishu resolves, reports, and replies exactly as before. Phase 0a still needs mechanical fixture and payload edits: 9 test files construct Feishu deployments through `testDeployment` (whose default includes `feishu`) or read `deployment.feishu`, and `feishuProblem` appears in panel, service-script, client, and settings fixtures.
4. `ChannelLinks` call sites compile with `{ repository, sources }`, and `feishuLink` reads its profile from `sources.feishu`.
5. The TypeScript build and `pnpm vitest run` both pass.

## 16. Setup and operations

### 16.1 The app manifest

The app is created once, by hand, from a manifest at `api.slack.com`. A manifest import is reproducible and reviews the scopes in one place. Version 1 is used because Slack's v2 manifests are for apps built with the Deno Slack SDK; apps that do not specify a version are treated as v1 ([App manifests](https://docs.slack.dev/app-manifests), [App manifest reference](https://docs.slack.dev/reference/app-manifest)).

```json
{
  "_metadata": { "major_version": 1, "minor_version": 1 },
  "display_information": {
    "name": "DSH Superagent",
    "description": "Turns authorised Slack requests into Tickets and executes them.",
    "background_color": "#1f2d3d"
  },
  "features": {
    "app_home": {
      "home_tab_enabled": false,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": { "display_name": "superagent", "always_online": false }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "channels:history",
        "channels:read",
        "channels:join",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "chat:write",
        "files:read",
        "users:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "app_uninstalled",
        "tokens_revoked"
      ]
    },
    "interactivity": { "is_enabled": false },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

Notes on the manifest:

- `features.app_home.messages_tab_enabled` is required for the Messages tab, which is where a user starts a DM with the bot; without it Slack hides the tab even though `message.im` events still arrive.
- `event_subscriptions` has no `request_url`: Socket Mode does not use one.
- `token_rotation_enabled: false` keeps the bot token static. Turning it on later means the bridge must implement refresh, which v1 does not.
- `channels:join` is what lets the Source join configured public channels; `chat:write.public` is not requested, because the bot only posts where it is a member.
- `files:read` is requested now although files are v1.1, because adding a scope later requires reinstalling and reissuing the token. An operator who wants the smallest possible scope set may remove it; nothing in v1 uses it.
- `users:read.email` and the reaction scopes are optional and not requested.

### 16.2 Create the app

1. Open `https://api.slack.com/apps` and choose **Create New App → From an app manifest**.
2. Choose the workspace. This is the only workspace the installation will serve.
3. Paste the manifest from section 16.1, review the scopes, and create the app.
4. Choose **Install to Workspace** and approve. Copy the **Bot User OAuth Token** (`xoxb-…`).
5. Under **Basic Information → App-Level Tokens**, generate a token with the `connections:write` scope and copy it (`xapp-…`).
6. Record who installed the app. The installation belongs to that account; if it leaves the workspace, the token is revoked.
7. Confirm **Socket Mode** is on and **Token Rotation** is off.

Slack's Socket Mode page describes the same steps for the app-level token and notes that a Socket Mode app cannot be distributed through the Marketplace ([Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)). Keeping the app internal is a design decision, not a limitation.

### 16.3 Install the bridge and its tokens

The package ships the bridge as the `slack-bridge` bin. A source checkout builds it with `pnpm build`; `npm link` (or `pnpm link --global`) then puts it on PATH, or the operator sets `config.cli` to the absolute path of `lib/slack-bridge.js`.

```sh
slack-bridge auth <<'EOF'
{"bot_token":"xoxb-…","app_token":"xapp-…"}
EOF
```

The command prints the workspace and bot it validated and writes `~/.slack-dsh-superagent/config.json` with mode `0600`. `slack-bridge api auth.test` re-prints the identity and is the same call the setup probe makes. The tokens are now in one file outside the repository and outside the settings database; `dsh-superagent` never reads or writes them.

### 16.4 Settings

The Source card has one field for the bridge path, the conversation rows, the other-conversations choice, the direct-message switch, and two advanced numbers. A filled-in example is in section 6. The setup fields are `cli`: changing the path triggers a setup re-check, like changing the Feishu `cli`. The card's setup problem is the `slack` entry of the state payload's `problems` map (section 15.3); a kind with no problem has no entry.

### 16.5 Policy

```json
{
  "policy": {
    "sources": {
      "slack": {
        "teamId": "T0123ABCD",
        "allowed": [
          { "id": "U0123ABCD", "name": "Ada" },
          { "id": "U0456EFGH", "name": "Grace" }
        ],
        "syncConversation": "C0123ABCD",
        "bots": []
      }
    }
  }
}
```

**Sync now** on the Policy card fills `allowed` from `syncConversation` and writes `teamId`. The admission cells are edited per row, exactly as for Feishu.

### 16.6 Joining conversations

- A configured public channel is joined automatically with `conversations.join` when the bot is not a member ([`conversations.join`](https://docs.slack.dev/reference/methods/conversations.join)). The join is attempted at startup and reconciled on every backfill pass, which re-reads the configuration roughly every 60 seconds, so adding or removing a public channel takes effect without a restart; a failure (for example `is_archived` or `missing_scope`) is a `slackNotAMember` health detail naming the conversation.
- A private channel cannot be joined by the bot. An operator invites the app with **Invite** in the channel; until then Slack sends no `message.groups` event for it, and the health detail says the conversation is configured but the bot is not a member.
- A DM needs no join. The Messages tab or a direct mention opens the conversation, and `message.im` starts arriving.
- The Source never posts into a public channel it was not invited to, even with `chat:write.public`; the scope is deliberately absent.

### 16.7 Health

| Entry | Meaning | Healthy detail |
| --- | --- | --- |
| `slack` | bridge process, socket, and tokens | `Connected to Acme as @superagent` |
| `history:slack` | backfill per conversation | `Up to date` or `N conversations behind` |
| `sync:slack` | roster sync, claimed by Settings | `Synced N people` |

The codes:

| Code | State | Cause |
| --- | --- | --- |
| `slackBridgeUnset` | paused | `cli` is empty |
| `setupPending` | paused | setup has not resolved the installation |
| `slackBridgeMissing` | error | the configured executable cannot be run |
| `slackTokenRevoked` | error | `token_revoked`, `invalid_auth`, `account_inactive` |
| `slackAppUninstalled` | error | `app_uninstalled` |
| `slackNotAMember` | error | a configured public channel cannot be joined, or a private one has no membership |
| `slackTeamChanged` | error | `auth.test` reports a different `team_id` than the policy's |
| `slackRateLimited` | ready, with a detail | the last call hit a 429; the bridge waited |
| `pollFailures` | error | the consumer failed more than the tolerated number of times |

Startup and every reconnect run `auth.test` through the bridge; `auth.test` is deliberately cheap ([`auth.test`](https://docs.slack.dev/reference/methods/auth.test)). `app_uninstalled` and `tokens_revoked` are the two events that make a healthy installation unusable without a single failed call, which is why they are subscribed even though they are not message events ([`app_uninstalled`](https://docs.slack.dev/reference/events/app_uninstalled), [`tokens_revoked`](https://docs.slack.dev/reference/events/tokens_revoked)).

### 16.8 Failure modes

| Symptom | Health | Cause | Operator action |
| --- | --- | --- | --- |
| `invalid_auth` on every call | `slackTokenRevoked` | token rotated, app reinstalled, or installer left | install the app again, run `slack-bridge auth`, restart |
| `missing_scope` naming a scope | `slackTokenRevoked` detail | scope added to the kind but not to the installed app | add the scope in the app, reinstall, `auth` again |
| `not_in_channel` on send | `slack` error detail | the bot left or was removed from the conversation | re-invite or remove the conversation from `chats` |
| `channel_not_found` on send | reply `gone` | conversation deleted or the address is stale | no action; the receipt settles as gone |
| `is_archived` | reply `gone` | conversation archived | no action |
| socket never becomes ready | `slack` error | bridge missing, config unreadable, Socket Mode off | run `slack-bridge api auth.test`; check `[socket] disabled` |
| `[socket] disabled` | `slack` error | Socket Mode was turned off in the app settings | turn it on; the bridge exits 1 and the loop retries |
| 429 storms | `slackRateLimited` | several replies or a large backfill | backfill pages are sequential; check for a second process using the same token |
| `team_id` mismatch | `slackTeamChanged` | the installation moved to another workspace | clear the policy's `teamId`, re-sync, or restore the old installation |
| no DMs arrive | `directMessages` off, or no Messages tab | configuration or manifest | enable `directMessages` and `features.app_home.messages_tab_enabled` |
| mentions in an unlisted channel are ignored | none | `otherChats: 'none'` | set `otherChats: 'mentions'` |

### 16.9 Operator walkthrough

1. Create the app from the manifest (16.2), install it, and store the tokens (16.3).
2. Run `slack-bridge api auth.test`; it prints the workspace and bot.
3. Install or build dsh-superagent, open Settings → Sources → Slack, set the bridge path, and add one conversation with `listen: 'all'`.
4. Save. The setup probe resolves the installation; the Overview shows `slack` ready and `history:slack` up to date.
5. Invite the bot to a private channel if one is configured; a public one is joined automatically.
6. Mention the bot in the channel. A Ticket appears in the panel; the reply appears in the message's thread.
7. Send a DM. It starts its own Thread and the answer is threaded under it.
8. Stop the process for a few minutes, then start it. The socket reconnects and the backfill reads the gap with five seconds of overlap; no Trigger is duplicated.
9. Change the app's scopes. Reinstall, copy the new bot token, run `slack-bridge auth` again, and restart. The health returns to ready.
10. Upgrade dsh-superagent. The bridge is part of the package; a version change is a new bin, and the operator re-links or updates the path.

## 17. Worker environment and prompts

### 17.1 Variables

| Variable | Description | Value |
| --- | --- | --- |
| `DSH_SUPERAGENT_SLACK_BOT` | The Slack bot; the bridge acts as it | the bot's display name, falling back to `bot_id` |
| `DSH_SUPERAGENT_SLACK_CONVERSATION` | The conversation that started the Ticket; empty elsewhere | `trigger.meta.conversation` for a Slack Trigger |

The second variable is named `CONVERSATION`, not `CHAT`, to match the terminology rule (section 3). It is the exact value a worker passes to `slack-bridge api`, so a worker can read the triggering conversation without parsing prompts. The variables follow the same rules as Feishu: declared in `kind.environment.variables`, generated into `runtime/environment`, and empty when the Ticket did not start on Slack.

### 17.2 The PATH shim

`src/infra/environment.ts` adds `slack-bridge` to `WORKER_COMMANDS`, so a blocked-command setting cannot block it, and writes a shim like the `lark-cli` one when a Slack profile exists:

```sh
#!/bin/sh
# Written by dsh-superagent on every start; edits are lost.
PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -vx "$DSH_SUPERAGENT_WORKER_BIN" | paste -sd: -)"
exec "/path/to/slack-bridge" "$@"
```

When no Slack profile exists, the shim is not written and any use fails with "slack-bridge is unavailable: this installation has no Slack app.", the wording pattern used for `lark-cli`. The shim removes `worker-bin` from PATH before exec, so recursion is impossible even if the configured path is a bare `slack-bridge`.

### 17.3 The skill

`skills/dsh-superagent-slack/SKILL.md` mirrors `skills/dsh-superagent-feishu/SKILL.md`:

- what the Source is and which conversations reach the agent;
- how to call the bridge (`slack-bridge api <method>` with the worker shim), with two examples: `conversations.info` for a conversation and `chat.getPermalink` for a message;
- the `slack/<trigger-id>/…` resources and which parts exist (`message`, `root`, `parent`, `thread`, `around`);
- the reply rule: one short message, at most 100 words, posted in the thread; no Block Kit and no user mentions;
- identity rules: a Slack id is not a GitHub or Feishu account, and `users.info` needs `users:read`;
- limits: no images or files in v1.

`src/app/skill-files.ts` gains `slack: load('slack')`; `src/app/context.ts` adds `slack` to `sourceSkills`; `src/app/prompts.ts` adds `'skill/slack'` to `PART_KEYS` with the same `${sourceSkills.slack}\n\n## CLI usage\n${cliNotes}` template as Feishu, and `src/app/sessions.ts` and `src/app/http.ts` accept the third built-in skill name. Locales add `promptPart.skill/slack` and the skill name.

The prompts keep the generic sentence "Chat messages are one sentence by default, with a hard limit of 100 words." No Slack-specific wording is added to a prompt that Feishu users also read, and no Feishu wording is copied into the Slack part. The skill describes Slack mechanics; the shared parts describe the rules.

## 18. Core touch points

The implementation touches these files. The table is the debt list: each row is a place that currently knows about Feishu or about a single chat Source.

| File | Change | Why |
| --- | --- | --- |
| `src/sources/kind.ts` | add `ChannelLinks.sources`, `SourceChannel.words`, `SourceKind.setup` | per-source profiles, per-Channel word limit, kind-provided probes |
| `src/sources/loop.ts` | new shared supervisor (Phase 0b) | one copy of spawn/readiness/restart/backoff/stop |
| `src/sources/slack*.ts` | new modules | the Source itself |
| `src/deployment.ts` | `Deployment.sources`, `resolveSlackBot`, no `SETUP_FIELDS` | per-source slots |
| `src/setup.ts` | `SetupPlace` becomes a kind string, Slack codes | one problem per kind |
| `src/app/setup.ts` | map of problems, loop over kinds, probe per kind | no third special case |
| `src/app/source-context.ts` | `problems` map | each kind reads its own problem |
| `src/infra/commands.ts` | `lark()` reads `deployment.sources.feishu`; a Slack accessor sits beside it | shared command access |
| `src/app/views/sources.ts` | one `problems` map keyed by kind; `problemOf` looks up the kind | panel reads per-kind setup state |
| `src/app/outbox.ts` | use `channel.words`, not `source === 'feishu'` | the 100-word rule applies to every chat Source |
| `src/app/links.ts` | pass `sources` instead of `feishu` | generalized profile access |
| `src/app/resources.ts` | `slack/` reader, `slackRef`, `slackReferences`; make the Feishu-only branches kind-driven | the Executor reads Slack originals |
| `src/app/http.ts` | problems map in the payload | panel |
| `src/app/views/settings.ts` | `kind.setup?.fields` | restart detection per kind |
| `src/client/deployment.tsx`, `overview.tsx` | iterate profiles; kind-keyed labels | panel |
| `src/client/locales.ts` | Slack source, health, problem, skill, deployment keys | localization |
| `src/client/provider.tsx` | follow the kind-keyed `problems` map | panel payload typing |
| `tests/fixtures/` | build `sources` profiles and kind-keyed problems | tests exercise the new payload |
| `src/infra/text.ts` | `checkedImText(text, limit)`, keep `IM_WORDS` as the default | one rule, two channels |
| `src/infra/environment.ts` | `slack-bridge` in `WORKER_COMMANDS` and the shim | workers call the bridge |
| `src/app/prompts.ts`, `context.ts`, `skill-files.ts`, `sessions.ts` | `skill/slack`, bundled skill, built-in names | prompts |
| `src/app/migration.ts` | recognize Slack resource and trigger shapes when scanning old records; no new legacy migration | records written before Slack existed must not break |
| `docs/001-domain.md` | glossary rows | terminology |
| `docs/003-execution.md` | two Slack variables in the execution table | workers |
| `docs/004-prompts.md` | `skill/slack` in the built-in parts | prompts |
| `docs/005-panel.md` | Slack source card and health rows | panel |
| `docs/006-deployment.md` | Slack account, health rows, troubleshooting | operations |
| `docs/007-architecture.md` | module and test rows | the documentation test |
| `cordis.patch.yml`, `tsdown.config.ts`, `package.json` | plugin id, entries, `./slack-watch` export, `bin` | packaging |

`src/app/migration.ts` deserves a note. It repairs older records for Feishu (`feishuTopics`, `feishuDirectAddresses`, `feishuThreadLinks`). Slack records cannot exist before this change, so no migration for them is needed; the only requirement is that the generic record scanners do not assume `source: 'feishu'`, which they already handle by reading the `source` field. The `feishu-read:` and `github-read:` KV cleanup stays as it is.

## 19. Phases and acceptance criteria

Phase 0 is required before any Slack code. Later phases may land as separate commits but each one keeps the test suite green.

**Phase 0a: per-source slots.** The deployment, setup, context, panel, and locale changes of section 15. Acceptance: section 15.5.

**Phase 0b: shared supervisor.** `src/sources/loop.ts` and the Feishu migration of section 14.1. Acceptance: the Feishu consumer tests pass unchanged; `consumerRetry` numbers are the same; the readiness timeout and exit text are the same strings; `feishu-loops.ts` contains no spawn or backoff code.

**Phase 1: the bridge.** `src/sources/slack-bridge.ts`, the `bin` entry, and `tests/slack-bridge.spec.ts`. Acceptance: `auth` writes a `0600` file and refuses a bad token; `api auth.test` prints the response and the right exit code; `listen` prints `[socket] ready` and NDJSON frames against a local stand-in socket; no token appears in stdout, stderr, or argv.

**Phase 2: translation, Channel, context.** `slack-trigger.ts`, `slack-channel.ts`, `slack-read.ts`, and their tests. Acceptance: a recorded fixture of each event type becomes the expected Trigger; self-echo is dropped; ids are deterministic across runs; replies carry `thread_ts`; the 100-word limit rejects with the standard message.

**Phase 3: the kind and the loops.** `slack.ts` and `slack-loop.ts`, with the fake-bridge test. Acceptance: a fake stream produces Tickets; a killed consumer restarts with the documented backoff; health moves `starting → ready → error → ready`; backfill reads a gap once with five seconds of overlap and never duplicates.

**Phase 4: setup, policy, panel, environment, prompts.** The `setup` member, `resolveSlackBot`, roster sync, the join check, the bridge shim, the skill, and the docs. Acceptance: a fresh install shows the Slack card and probe; Sync now fills the roster in a stable order; the worker sees both variables and can call `slack-bridge api`; the skill renders in the panel and the prompt.

**Phase 5: verification.** `pnpm vitest run`, the TypeScript build, and a manual walkthrough against a real workspace as in section 16.9. Acceptance: the documentation test passes, including the new 007 rows; a mention, an all-messages channel, a DM, a thread reply, and a restart after downtime all produce exactly one Ticket each.

## 20. Test plan

The tests follow the patterns already in the repository: real `Store` in a temp directory, a real `Commands` over a fake executable, and `vi.waitFor` on health.

| Test | Covers |
| --- | --- |
| `tests/slack-trigger.spec.ts` | each event type becomes the expected Trigger; ids are stable across two parses; bot messages (`bot_id`, `bot_profile`, `subtype: 'bot_message'`) are dropped; threads and DMs get the documented thread ids; the same envelope twice yields one Trigger id; edited timestamp does not change the id |
| `tests/slack-channel.spec.ts` | `chat.postMessage` argv with and without `thread_ts`; no `client_msg_id`; text checking; `gone` for `channel_not_found`, `is_archived`, `not_in_channel`; `link` from permalinks including custom domains; `words` asks for the 100-word check |
| `tests/slack-read.spec.ts` | `conversations.replies` pages and oldest-first ordering; a message with `thread_ts` absent reads neighbours; edited text appears from a read; `reply_to` mapping; both URL forms |
| `tests/slack.spec.ts` | `scope()` for listed, other, and direct with every `listen` combination; admission rows match the table; `channel.allowed` agrees with `scope()`; policy schema rejects a non-`U…`/`W…` id; roster order is preserved; `environment.values` for Slack and non-Slack Triggers; `repliesTo` for a reply and for a parent |
| `tests/slack-loop.spec.ts` | fake bridge in the modes of section 13.8: ready, warn, flaky, events, late, never; readiness timeout message; backoff numbers 1000/2000/…/60000; stop during spawn; `app_rate_limited` sets a warning; `app_uninstalled` sets an error and stops retrying forever |
| `tests/slack-bridge.spec.ts` | `auth` writes `0600` and rejects a client-side `ok:false`; `api` exits 0 for `ok:true` and `ok:false`, 1 for a transport or parse failure, 2 for usage; `listen` maps `disconnect` to exit 1 and prints NDJSON only on stdout; token never in argv or output |
| `tests/sources.spec.ts` (extended) | the Feishu consumer still works after the supervisor extraction; a Slack instance is admitted, replied to, and ignored through the Outbox; the Feishu word check still fires; a Slack reply over 100 words is rejected with the standard message |
| `tests/docs.spec.ts` | numbering, links, and the 007 module and test tables, including the new files |

Three properties are worth testing by name:

- **No replay.** A Trigger id is the same before and after a restart, and `Intake` drops a duplicate id. The backfill cursor is the only thing that advances; a restart reads from the cursor, not from the newest message.
- **One reply per request.** A recovery job re-sends only receipts that were never settled; an emitted receipt is stable, so the same request cannot produce two emitted replies, and a duplicate send is a documented risk rather than a test failure.
- **The seam.** The fake bridge is a shell script, not a mock, so the test exercises the real `Commands.run` argv, the real environment, and the real line splitting.

The manual walkthrough in section 16.9 covers what a unit test cannot: a real workspace, a real socket refresh, and a reinstall.

## 21. Out of scope

- **Images and files.** v1.1. The events already carry `files[]`, and `files:read` is in the manifest, but no part of v1 downloads a file (`url_private` requires the token and must be sent only to a Slack host, [File object](https://docs.slack.dev/reference/objects/file-object)).
- **Block Kit.** No blocks are sent or parsed. The bridge posts plain `text`, which Slack renders as mrkdwn.
- **Streaming and progress messages.** No `chat.update`, no streaming API, no typing indicator.
- **Multi-workspace and OAuth.** One installation, one `team_id`, static tokens, no redirect.
- **Enterprise Grid and org-wide installs.** `W…` ids are accepted in the schema because a Grid workspace issues them, but an org-wide installation is not supported and no enterprise-level events are handled.
- **Reactions as triggers.** `reaction_added` is not subscribed and reactions do not address the agent.
- **Slash commands and interactivity.** The manifest leaves interactivity off; there is no command surface.
- **Message edits and deletions as triggers.** Both are ignored for triggering (section 7.2); reads show current text.
- **The HTTP Events API.** No public URL, no signature verification, no tunnel.
- **Marketplace review.** The app stays internal, which Slack's own documentation describes as incompatible with a public listing.
- **Thread polling.** Slack delivers thread replies as ordinary message events; the Feishu-style poller is not ported.
- **A `chat:write.customize` bot name.** The bot posts under its own name.
- **Backfill older than 14 days.** The window is a ceiling, not a promise; a longer outage is recovered only as far as the ceiling allows.

## 22. Open questions

Only genuine unknowns are listed. Each has a proposed default, so none blocks implementation.

1. **Does Socket Mode replay events after a disconnect?** Slack's page says the app must acknowledge events and describes the client as reconnecting, but it does not document an offline buffer. [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode). **Default:** treat the stream as lossy, never depend on replay, and rely on the backfill cursor. Implementations must not assume exclusivity with the backfill either.
2. **Does a mention also produce a `message.channels` event?** The event pages say `app_mention` "is not a message like the message.* event types", which suggests both are delivered, but do not state it. [`app_mention`](https://docs.slack.dev/reference/events/app_mention), [`message.channels`](https://docs.slack.dev/reference/events/message.channels). **Default:** assume double delivery is possible and dedupe on the deterministic Trigger id, which both translations produce from the same `ts`. If testing shows `app_mention` is the only delivery, the dedupe is harmless.
3. **What is the exact `chat.postMessage` rate for a new app?** Slack calls it a special tier and describes it as roughly one message per channel per second without stating the burst. [Rate limits](https://docs.slack.dev/apis/web-api/rate-limits). **Default:** one send at a time globally and `Retry-After` on 429; do not tune against the number.
4. **Is `thread_ts` always present on `app_mention` for a threaded mention?** The event page says it is carried "in practice" but the field is optional in the payload. **Default:** when absent, treat the message as top-level and start a thread on it; do not make an extra read to recover the parent.
5. **Does `thread_broadcast` produce one event or two?** A broadcast reply reaches both the channel and the thread, and the message event page lists `thread_broadcast` as a subtype without stating the delivery count. **Default:** dedupe on the Trigger id, which is the same for either delivery.
6. **Does editing a message's `ts` change?** Edits arrive as `message_changed` with the same `ts`; deleted messages keep their `ts` in the event. Neither is a trigger, so this only matters for reads, where the current text is returned. **Default:** no action; document that an edited original may read differently from the Trigger text.
7. **Does `conversations.replies` include replies older than the parent when `latest` is set?** The endpoint accepts `oldest`/`latest`, and the page does not describe their interaction with thread paging. [`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies). **Default:** page by cursor, never by time, inside a thread.
8. **What is the exact lifetime of an `xoxb-` token when `token_rotation_enabled` is false?** Slack describes it as long-lived and revocable, not immortal ([Tokens](https://docs.slack.dev/authentication/tokens)). **Default:** treat any `invalid_auth` as revocation and surface `slackTokenRevoked`; never retry a revoked token forever.
9. **Is `app_uninstalled` guaranteed within a bounded time?** The event page does not state a delay. **Default:** also run `auth.test` on every reconnect and on each backfill round, so a missing event still becomes an error within a minute.





