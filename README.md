# dsh-superagent

> **Personal fork.** This is a personal fork of
> [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)
> based on commit [`8c32a9d`](https://github.com/deepseek-ai/dsh-superagent-prototype/commit/8c32a9dc5d72c033816c6a8110b37f40cf94fba4).
> Local customizations are tracked in [CUSTOMIZATIONS.md](CUSTOMIZATIONS.md).

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

dsh-superagent runs as a native macOS process under tmux. That is the primary deployment; the Docker path is frozen as an experimental opt-in and the rollback window ([ADR 0004](docs/adr/0004-host-native-deployment.md)). Install the pinned DeepSeek Harness CLI, then create a dedicated profile and install the bundle:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

Start and inspect the instance:

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`scripts/dsh-superagent` is the operator entry point. It runs `dsh --profile superagent` in tmux session `dsh-superagent`, waits for readiness and reports JSON status; the panel URL and its per-boot token are in the `dsh web:` line of the newest `.artifacts/dsh-superagent-*.log`. Use `--profile livis --url http://127.0.0.1:3083` for the `livis` instance. The Docker/Compose wrapper remains available as `scripts/dsh-superagent-docker`; [006 Deployment](docs/006-deployment.md) covers prerequisites, credentials, the four status exit codes, the hourly check, upgrades and the frozen Docker appendix.

To have an agent walk through the installation with you, ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): host-native install, run, credentials, upgrades and troubleshooting; frozen Docker appendix
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

The deployment vocabulary is defined in [GLOSSARY.md](GLOSSARY.md). [ADR 0004](docs/adr/0004-host-native-deployment.md) records the move to host-native deployment, and [ADR 0002](docs/adr/0002-docker-deployment.md) is superseded.

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
