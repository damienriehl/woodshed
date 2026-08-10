# Woodshed

Woodshed is an open-source, multiplayer workspace for participatory music communities. It will help communities choose songs, staff arrangements, coordinate rehearsals, and run adaptable live performances.

This repository is a clean-history rebuild. It contains synthetic examples only and has no dependency on private Hootenanny services or data. The first foundation release establishes the privacy boundary and contribution contract; product capabilities will arrive behind portable, versioned contracts.

## Requirements

- Node.js 24 or newer (Node.js 24 is the reference release)
- Git, for tracked-file and history release checks

## Run the public foundation

Install the exact reviewed dependency graph:

```sh
npm ci
```

Start the connected participant preview with its local API and synthetic database:

```sh
npm run dev
```

Open the printed `http://127.0.0.1:4174` URL. Event discovery, open accountless joining, ranked-ballot saves, and song proposals persist through the local Node/SQLite API on port 3100. Override those defaults with `WOODSHED_WEB_PORT` and `WOODSHED_API_PORT`. Synthetic development state lives in the operating system’s temporary directory, outside the repository and its public-release boundary. Rehearsal and stage-lead controls are still explicitly labeled simulations.

To run only the Node/SQLite API reference in a second terminal:

```sh
npm run dev -w @woodshed/api-node -- --demo
```

Without `--demo`, the API creates `woodshed.sqlite` in the working directory unless `WOODSHED_DB` names another path and does not seed any data. The connected preview is a development workflow, not a production deployment.

## Verify the foundation

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm run privacy
```

`npm run test:conformance` exercises the same participant-choice behavior against both the Node SQLite reference adapter and a genuine local Cloudflare D1 binding hosted by Miniflare. The D1 test is local-only and never connects to production data.

Before publishing a release, run `npm run verify:release -- --expected-ref <full-commit-sha>` from a clean checkout. This binds the evidence to the exact release identity and scans the worktree, tracked files, and reachable history.

See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/architecture.md](docs/architecture.md), and [docs/privacy.md](docs/privacy.md).

Forks and derived projects are welcome. Please do not imply that a fork is an official Woodshed distribution or service.
