# Glossary

dsh-superagent is one product that runs as several instances, each with a DeepSeek Harness profile of its own. This glossary fixes the words for that arrangement and for the interfaces around it. The domain vocabulary — Agent, Source, Ticket, Executor Session and the rest — lives in [001 Domain model](docs/001-domain.md); this file adds the deployment words and disambiguates names that would otherwise collide.

## Language

### The product and its instances

**dsh-superagent** (the product):
The bundle in this repository: the DeepSeek Harness plugin, prompts, skills and documentation that add the superagent domain to a profile. It is not a running agent, not an instance and not a profile.
_Avoid_: superagent (when the product is meant), app, service.

**Instance**:
One deployed copy of dsh-superagent serving one team: one profile, one state directory, one panel and one container. Instances share the product code and the image; they do not share state.
_Avoid_: deployment (that is the arrangement of instances), service (that is Compose's word for the container definition), environment.

**Deployment**:
The whole arrangement that runs one or more instances: the image, Compose services, volumes, published ports and credentials.
_Avoid_: install (the act of setting it up), instance.

**Profile** (DeepSeek Harness profile):
A named stack of DeepSeek Harness plugin bundles and settings under a DSH home. It selects the product, the model channel, the web server port, the state directory and the Source plugins. A profile is configuration; an instance is one running copy of it.
_Avoid_: instance, config file (a profile is a layered directory, not one file).

**Image**:
An immutable build of the product at one repository commit, together with a pinned DeepSeek Harness version, the production dependencies and a profile template. Containers are created from it, and it carries no credentials.
_Avoid_: container, instance, checkout.

**Container**:
The isolated filesystem and network created from an image for one instance, with its own DSH home and state volume. Exactly one container runs per state directory, because the orchestrator holds an exclusive state-directory lock.
_Avoid_: instance (the product inside it), image.

**Volume**:
Docker-managed persistent storage mounted into a container: here, the instance's DSH home and its state directory. A volume outlives a container and is not a host directory bind mount.
_Avoid_: disk, mount (that is the act).

### Running and supervising

**Runtime**:
The running dsh-superagent application inside a container: the part that owns the management API, the Sources, the Executor and the state. Health output uses "runtime" for this application; DeepSeek Harness is the host that loads it, and the container is its packaging.
_Avoid_: container, DeepSeek Harness.

**Panel**:
The web interface dsh-superagent serves for the operator. DeepSeek Harness's web app serves it on the instance's loopback URL with a token that changes each boot.
_Avoid_: dashboard, console, UI.

**Operator**:
The person who runs an instance, configures its Sources and policies, and owns what the agent does. The operator supervises; the Agent acts; Workers execute Tickets.
_Avoid_: admin, user, agent.

**Agent CLI**:
The command configured on a Source that acts as the agent's own account — `gh`-compatible for GitHub, `lark-cli` for Feishu. Setup checks and workers run it instead of the operator's own credentials.
_Avoid_: token, credential helper, gh (when any Agent CLI is meant).

**Model channel**:
The route a profile uses for model calls: `deepseek-official` with a DeepSeek API key, or `deepseek-account` with a DeepSeek Harness account login. A profile configures the routes it can use; dsh-superagent calls the profile's default model unless the Eval or Execution settings name another. The Docker image supplies a credential for neither route.
_Avoid_: model (the thing being called), provider (the vendor), API key (one authentication method).

### Work

**Worker**:
The name in code and prompts for a DeepSeek Harness Session that executes one Ticket's Assignment. The canonical domain term is Executor Session. A worker is not the Agent, not the operator and not a container.
_Avoid_: agent, executor (the port), subagent.

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
