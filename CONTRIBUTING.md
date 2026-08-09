# Contributing

Contributions are welcome through ordinary GitHub pull requests; no Developer Certificate of Origin sign-off is required. By contributing, you agree that your contribution is provided under this repository's MIT License.

Use synthetic data in tests, examples, screenshots, bug reports, and recordings. Never copy private event data, operational scripts, hostnames, credentials, database exports, or generated production artifacts into this repository.

Before opening a pull request, run:

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm run privacy
```

Add public files intentionally. The clean public boundary is allowlist-based: reviewers should verify every new path, its provenance, its license, and its data classification. Cleanup and rollback automation should be identity-scoped and re-entrant so reruns affect only artifacts owned by the exact operation.
