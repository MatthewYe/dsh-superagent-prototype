# Glossary

dsh-superagent is one product that runs as several instances, each with a DeepSeek Harness profile of its own. This glossary fixes the words for that arrangement, for the interfaces around it, and for the voice path. The domain vocabulary — Agent, Source, Trigger, Thread, Ticket, Mandate, Eval, Subscription, Channel, Executor Session and the rest — lives in [001 Domain model](docs/001-domain.md); this file adds the deployment and voice words and disambiguates names that would otherwise collide.

## Language

### Deployment vocabulary

**Agent CLI**:
The command configured on a Source that acts as the agent's own account — `gh`-compatible for GitHub, `lark-cli` for Feishu. Setup checks and workers run it instead of the operator's own credentials.
_Avoid_: token, credential helper, gh (when any Agent CLI is meant).

**Container**:
The isolated filesystem and network created from an image for one instance, with its own DSH home and state volume. Exactly one container runs per state directory, because the orchestrator holds an exclusive state-directory lock.
_Avoid_: instance (the product inside it), image.

**Deployment**:
The whole arrangement that runs one or more instances: the image, Compose services, volumes, published ports and credentials.
_Avoid_: install (the act of setting it up), instance.

**dsh-superagent** (the product):
The bundle in this repository: the DeepSeek Harness plugin, prompts, skills and documentation that add the superagent domain to a profile. It is not a running agent, not an instance and not a profile.
_Avoid_: superagent (when the product is meant), app, service.

**Image**:
An immutable build of the product at one repository commit, together with a pinned DeepSeek Harness version, the production dependencies and a profile template. Containers are created from it, and it carries no credentials.
_Avoid_: container, instance, checkout.

**Instance**:
One deployed copy of dsh-superagent serving one team: one profile, one state directory, one panel and one container. Instances share the product code and the image; they do not share state.
_Avoid_: deployment (that is the arrangement of instances), service (that is Compose's word for the container definition), environment.

**Model channel**:
The route a profile uses for model calls: `deepseek-official` with a DeepSeek API key, or `deepseek-account` with a DeepSeek Harness account login. A profile configures the routes it can use; dsh-superagent calls the profile's default model unless the Eval or Execution settings name another. The Docker image supplies a credential for neither route.
_Avoid_: model (the thing being called), provider (the vendor), API key (one authentication method).

**Operator**:
The person who runs an instance, configures its Sources and policies, and owns what the agent does. The operator supervises; the Agent acts; Workers execute Tickets.
_Avoid_: admin, user, agent.

**Panel**:
The web interface dsh-superagent serves for the operator. DeepSeek Harness's web app serves it on the instance's loopback URL with a token that changes each boot.
_Avoid_: dashboard, console, UI.

**Profile** (DeepSeek Harness profile):
A named stack of DeepSeek Harness plugin bundles and settings under a DSH home. It selects the product, the model channel, the web server port, the state directory and the Source plugins. A profile is configuration; an instance is one running copy of it.
_Avoid_: instance, config file (a profile is a layered directory, not one file).

**Runtime**:
The running dsh-superagent application inside a container: the part that owns the management API, the Sources, the Executor and the state. Health output uses "runtime" for this application; DeepSeek Harness is the host that loads it, and the container is its packaging.
_Avoid_: container, DeepSeek Harness.

**Volume**:
Docker-managed persistent storage mounted into a container: here, the instance's DSH home and its state directory. A volume outlives a container and is not a host directory bind mount.
_Avoid_: disk, mount (that is the act).

**Worker**:
The name in code and prompts for a DeepSeek Harness Session that executes one Ticket's Assignment. The canonical domain term is Executor Session. A worker is not the Agent, not the operator and not a container.
_Avoid_: agent, executor (the port), subagent.

### Voice vocabulary

**Confirmation gate**:
The spoken go-ahead a work request must receive before it becomes a Ticket. A read-only turn never reaches it.
_Avoid_: approval, yes/no step, consent prompt.

**DSH bridge**:
The versioned connection between the Jarvis relay and the Jarvis source: turns travel towards dsh-superagent, text deltas and cancellations travel back. It is the only contract the two products share.
_Avoid_: voice gateway, relay bridge, websocket channel.

**Fast path**:
The voice answer the main Session writes in one hop, with no Eval and no Ticket, spoken while it streams. It serves read-only turns.
_Avoid_: fast channel, quick answer, direct reply.

**Filler line**:
The short sentence spoken when the first text delta is slow to arrive, so the device is not silent while the model starts. It is not part of the answer.
_Avoid_: hold message, placeholder, thinking sound.

**First audio latency**:
The time from the end of the person's utterance to the first audible syllable of the answer. It covers model time to the first sentence and the start of speech synthesis.
_Avoid_: latency, response time, TTFT (that is the model's first token).

**Jarvis source**:
The dsh-superagent Source that turns one finished voice turn from the Jarvis relay into one Trigger. dsh-superagent keeps the record of what was asked and answered; the audio stays in Jarvis.
_Avoid_: voice source, voice channel (a Channel is the domain's write side), Jarvis relay (when the Source is meant).

**Main Session**:
dsh-superagent's long-lived Session, the one that holds the orchestrator's routing context and answers what does not need a Ticket. It is shared by the relays and by the voice fast path.
_Avoid_: master session (the runtime's own name for it), router session, orchestrator session.

**Slow path**:
The ordinary ticket path a voice turn takes once it asks for work: Trigger, Eval, Ticket, worker, then a report back to the device.
_Avoid_: slow channel, work path, ticket path.

**Soft constraint**:
A rule stated in a prompt that no code enforces, as opposed to a gate checked before an effect. The confirmation rule and the strength of a voice request are soft constraints in v1.
_Avoid_: prompt hint, guideline, best effort.

**Voice marker**:
The mark a voice turn carries so the voice prompt rules apply to it and to no other turn. Relay messages and events from other Sources never carry it.
_Avoid_: voice flag, prefix, tag.

**Voice turn**:
One completed utterance from a voice device, handed to dsh-superagent as one Trigger. In v1, one opening of the microphone is one voice turn, ended by trailing silence, the spoken end word or a manual stop.
_Avoid_: utterance, voice message, recording.

## One name, three things

The product, its profile and its instance share the word "superagent". Use the qualifier when it matters.

| Name | Product | Profile | Instance |
|------|---------|---------|----------|
| `dsh-superagent` | the code and its image | — | — |
| `superagent` | — | the profile that loads the product | the instance at `127.0.0.1:3082` |

So: the `dsh-superagent` product is built into an image; the `superagent` profile configures it; the `superagent` instance runs it. An instance is not the product, and a profile is neither.

## "Livis" in this repository

This repository uses *livis* in two senses that must not be mixed:

- The `livis` instance: the planned second instance, which will run the `livis` profile and the Livis source plugin on loopback port 3083. It is a second use of the same dsh-superagent product, not part of it.
- The Livis product line: the glasses and relay product outside this repository, whose source plugin (`dsh-livis-source`) the planned `livis` profile will load. This repository does not contain that product or its plugin.

Unqualified, `livis` in these documents means the instance. The product and its plugin are always qualified as "the Livis product" and "the Livis source plugin". At the time of writing the `livis` instance is a follow-up: the Compose file starts only `superagent`, and the image does not yet contain the Livis source plugin.

## Jarvis in this repository

Jarvis is the voice relay product outside this repository. Its relay, its devices, its audio pipeline and the plugin that implements the Jarvis source all live there; this repository defines the Source contract and the domain rules every Trigger keeps. Unqualified, "Jarvis" means the product; "the Jarvis source" and "the DSH bridge" are the integration's own names.
