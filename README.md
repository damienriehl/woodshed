# Woodshed

Woodshed is an open-source, multiplayer workspace for participatory music communities. It will help communities choose songs, staff arrangements, coordinate rehearsals, and run adaptable live performances.

This repository is a clean-history rebuild. It contains synthetic examples only and has no dependency on private Hootenanny services or data. The first foundation release establishes the privacy boundary and contribution contract; product capabilities will arrive behind portable, versioned contracts.

## Requirements

- Node.js 20 or newer (Node.js 24 is the reference release)
- Git, for tracked-file and history release checks

## Verify the foundation

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm run privacy
```

Before publishing a release, run `npm run verify:release -- --expected-ref <full-commit-sha>` from a clean checkout. This binds the evidence to the exact release identity and scans the worktree, tracked files, and reachable history.

See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/architecture.md](docs/architecture.md), and [docs/privacy.md](docs/privacy.md).

Forks and derived projects are welcome. Please do not imply that a fork is an official Woodshed distribution or service.
