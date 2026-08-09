# Guided community-cloud installation

The one-click manifest describes the resources a community-owned cloud provider must create. It is intentionally marked `productionReady: false` until a provider adapter passes the same archive round-trip, restore, upgrade, and health matrices as Node/SQLite and Cloudflare.

The guided path asks only for a community name, region, and recovery contact. It must provision the database, coordinator, secret store, encrypted archive storage, and scheduled backups without exposing credentials in a URL or build log. Private content stays disabled.
