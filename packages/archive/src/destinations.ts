import { DatabaseSync } from "node:sqlite";
import type { D1Database } from "@cloudflare/workers-types";

import { canonicalJson } from "../../contracts/src/snapshot.ts";
import {
  canonicalManifest,
  validateCommunityArchive,
  type CommunityArchive,
  type SemanticManifest,
} from "./index.ts";

export interface ArchiveDestinationPort {
  migrate(): Promise<void> | void;
  stage(archive: CommunityArchive): Promise<void> | void;
  commit(archiveId: string, destinationCommunityId: string): Promise<void> | void;
  read(destinationCommunityId: string): Promise<CommunityArchive | undefined> | CommunityArchive | undefined;
  cleanup(archiveId: string): Promise<boolean> | boolean;
  manifest(destinationCommunityId: string): Promise<SemanticManifest | undefined> | SemanticManifest | undefined;
}

export class SqliteArchiveDestination implements ArchiveDestinationPort {
  private readonly db: DatabaseSync;

  constructor(filename = ":memory:") {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA foreign_keys=ON");
  }

  migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS archive_staging(archive_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS community_archive_pointers(community_id TEXT PRIMARY KEY,archive_id TEXT NOT NULL,payload_json TEXT NOT NULL);");
  }

  stage(archive: CommunityArchive) {
    const validated = validateCommunityArchive(archive);
    this.db.prepare("INSERT INTO archive_staging(archive_id,payload_json) VALUES(?,?) ON CONFLICT(archive_id) DO UPDATE SET payload_json=excluded.payload_json")
      .run(validated.archiveId, canonicalJson(validated));
  }

  commit(archiveId: string, destinationCommunityId: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT payload_json FROM archive_staging WHERE archive_id=?").get(archiveId) as { payload_json: string } | undefined;
      if (!row) throw new Error("archive not staged");
      const archive = validateCommunityArchive(JSON.parse(row.payload_json) as CommunityArchive);
      if (archive.destinationCommunityId !== destinationCommunityId) throw new Error("archive destination mismatch");
      this.db.prepare("INSERT INTO community_archive_pointers(community_id,archive_id,payload_json) VALUES(?,?,?) ON CONFLICT(community_id) DO UPDATE SET archive_id=excluded.archive_id,payload_json=excluded.payload_json")
        .run(destinationCommunityId, archiveId, row.payload_json);
      this.db.prepare("DELETE FROM archive_staging WHERE archive_id=?").run(archiveId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  read(id: string) {
    const row = this.db.prepare("SELECT payload_json FROM community_archive_pointers WHERE community_id=?").get(id) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as CommunityArchive : undefined;
  }

  cleanup(id: string) {
    return Number(this.db.prepare("DELETE FROM archive_staging WHERE archive_id=?").run(id).changes) > 0;
  }

  manifest(id: string) {
    const value = this.read(id);
    return value ? canonicalManifest(value) : undefined;
  }

  close() {
    this.db.close();
  }
}

export class D1ArchiveDestination implements ArchiveDestinationPort {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async migrate() {
    await this.db.exec("CREATE TABLE IF NOT EXISTS archive_staging(archive_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL) STRICT;CREATE TABLE IF NOT EXISTS community_archive_pointers(community_id TEXT PRIMARY KEY,archive_id TEXT NOT NULL,payload_json TEXT NOT NULL) STRICT;");
  }

  async stage(archive: CommunityArchive) {
    const validated = validateCommunityArchive(archive);
    await this.db.prepare("INSERT INTO archive_staging(archive_id,payload_json) VALUES(?,?) ON CONFLICT(archive_id) DO UPDATE SET payload_json=excluded.payload_json")
      .bind(validated.archiveId, canonicalJson(validated)).run();
  }

  async commit(archiveId: string, destinationCommunityId: string) {
    const row = await this.db.prepare("SELECT payload_json FROM archive_staging WHERE archive_id=?")
      .bind(archiveId).first<{ payload_json: string }>();
    if (!row) throw new Error("archive not staged");
    const archive = validateCommunityArchive(JSON.parse(row.payload_json) as CommunityArchive);
    if (archive.destinationCommunityId !== destinationCommunityId) throw new Error("archive destination mismatch");
    await this.db.batch([
      this.db.prepare("INSERT INTO community_archive_pointers(community_id,archive_id,payload_json) VALUES(?,?,?) ON CONFLICT(community_id) DO UPDATE SET archive_id=excluded.archive_id,payload_json=excluded.payload_json")
        .bind(destinationCommunityId, archiveId, row.payload_json),
      this.db.prepare("DELETE FROM archive_staging WHERE archive_id=?").bind(archiveId),
    ]);
  }

  async read(id: string) {
    const row = await this.db.prepare("SELECT payload_json FROM community_archive_pointers WHERE community_id=?")
      .bind(id).first<{ payload_json: string }>();
    return row ? JSON.parse(row.payload_json) as CommunityArchive : undefined;
  }

  async cleanup(id: string) {
    const result = await this.db.prepare("DELETE FROM archive_staging WHERE archive_id=?").bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async manifest(id: string) {
    const value = await this.read(id);
    return value ? canonicalManifest(value) : undefined;
  }
}
