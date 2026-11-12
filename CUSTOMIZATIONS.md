# Customizations

This repository is a personal fork of
[`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype).

- Base commit: [`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`](https://github.com/deepseek-ai/dsh-superagent-prototype/commit/8c32a9dc5d72c033816c6a8110b37f40cf94fba4)
- Branch model: `main` mirrors upstream (merge only `--ff-only`); `custom` carries local changes and is the default branch.

## Log

| Date | Area | Change | Commit |
|------|------|--------|--------|
| 2026-11-12 | repo | Marked this repository as a personal fork and added this customization log | c4b0be8 |
| 2026-11-12 | docs | Documented Docker as the primary deployment, added the deployment glossary and the Docker deployment ADR (issue #6) | (this commit) |

## Syncing with upstream

```sh
git fetch upstream
git switch main && git merge --ff-only upstream/main && git push origin main
git switch custom && git merge main
```
