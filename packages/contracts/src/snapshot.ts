import { createHash } from "node:crypto";
import { ContractValidationError } from "./index.ts";

export const SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const SNAPSHOT_PROFILE = "hootenanny/v1" as const;
const MAX_RECORDS = 100_000;
const MAX_ATTRIBUTES_BYTES = 16 * 1024 * 1024;
const MAX_ATTRIBUTE_DEPTH = 64;
const MAX_STRING_BYTES = 1024 * 1024;
export type SnapshotRecord = { type: string; sourceId: string; parentSourceId: string | null; tombstone: boolean; attributes: Record<string, unknown> };
export type NeutralSnapshot = {
  schemaVersion: 1; profile: string; mode: "full"; snapshotId: string; sourceIdentity: string;
  destinationCommunityId: string; createdAt: string; expiresAt: string; startWatermark: string; endWatermark: string;
  records: SnapshotRecord[]; counts: Record<string, number>; recordHashes: Record<string, string>;
};

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

function boundedValueSize(value: unknown, depth = 0): number {
  if (depth > MAX_ATTRIBUTE_DEPTH) throw new ContractValidationError("snapshot attribute nesting depth exceeded");
  if (value === null || typeof value === "boolean") return 4;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ContractValidationError("snapshot attributes contain a non-finite number");
    return 16;
  }
  if (typeof value === "string") {
    const size = Buffer.byteLength(value);
    if (size > MAX_STRING_BYTES) throw new ContractValidationError("snapshot attribute string size exceeded");
    return size;
  }
  if (Array.isArray(value)) return value.reduce((size, item) => size + boundedValueSize(item, depth + 1), 0);
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).reduce((size, [key, item]) => size + Buffer.byteLength(key) + boundedValueSize(item, depth + 1), 0);
  throw new ContractValidationError("snapshot attributes contain an unsupported value");
}

export function parseNeutralSnapshot(value: unknown): NeutralSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContractValidationError("snapshot must be an object");
  const s = value as Record<string, unknown>;
  if (s.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) throw new ContractValidationError("unsupported snapshot schema");
  if (s.profile !== SNAPSHOT_PROFILE) throw new ContractValidationError("unsupported snapshot profile");
  if (s.mode !== "full") throw new ContractValidationError("only full snapshots are supported");
  for (const field of ["snapshotId","sourceIdentity","destinationCommunityId","createdAt","expiresAt","startWatermark","endWatermark"])
    if (typeof s[field] !== "string" || s[field] === "") throw new ContractValidationError(`snapshot ${field} is required`);
  const createdAt = Date.parse(s.createdAt as string), expiresAt = Date.parse(s.expiresAt as string);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt) throw new ContractValidationError("snapshot dates are invalid");
  if (!/^\d+$/.test(s.startWatermark as string) || !/^\d+$/.test(s.endWatermark as string)) throw new ContractValidationError("snapshot watermark must be a numeric sequence");
  if (s.startWatermark !== s.endWatermark) throw new ContractValidationError("snapshot does not prove a consistent source watermark");
  if (!Array.isArray(s.records)) throw new ContractValidationError("snapshot records must be an array");
  if (s.records.length > MAX_RECORDS) throw new ContractValidationError("snapshot record limit exceeded");
  let attributeBytes = 0;
  const records = s.records.map((raw, i) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ContractValidationError(`record ${i} is invalid`);
    const r = raw as Record<string, unknown>;
    if (typeof r.type !== "string" || typeof r.sourceId !== "string" || (r.parentSourceId !== null && typeof r.parentSourceId !== "string") || typeof r.tombstone !== "boolean" || !r.attributes || typeof r.attributes !== "object" || Array.isArray(r.attributes)) throw new ContractValidationError(`record ${i} is invalid`);
    attributeBytes += boundedValueSize(r.attributes);
    if (attributeBytes > MAX_ATTRIBUTES_BYTES) throw new ContractValidationError("snapshot attribute size limit exceeded");
    return r as SnapshotRecord;
  });
  const ids = new Set(records.map(r => r.sourceId));
  if (ids.size !== records.length) throw new ContractValidationError("snapshot contains duplicate source IDs");
  for (const r of records) if (r.parentSourceId && !ids.has(r.parentSourceId)) throw new ContractValidationError(`record ${r.sourceId} has a missing parent`);
  const counts = s.counts && typeof s.counts === "object" && !Array.isArray(s.counts) ? s.counts as Record<string, number> : {};
  const actualCounts: Record<string, number> = {}; for (const r of records) actualCounts[r.type] = (actualCounts[r.type] ?? 0) + 1;
  if (canonicalJson(counts) !== canonicalJson(actualCounts)) throw new ContractValidationError("snapshot counts do not match records");
  const recordHashes = s.recordHashes && typeof s.recordHashes === "object" && !Array.isArray(s.recordHashes) ? s.recordHashes as Record<string, string> : {};
  if (Object.keys(recordHashes).length !== records.length || Object.keys(recordHashes).some(id => !ids.has(id)) || records.some(r => recordHashes[r.sourceId] !== sha256(r))) throw new ContractValidationError("snapshot record hash mismatch");
  return { schemaVersion: 1, profile: s.profile as string, mode: "full", snapshotId: s.snapshotId as string, sourceIdentity: s.sourceIdentity as string, destinationCommunityId: s.destinationCommunityId as string, createdAt: s.createdAt as string, expiresAt: s.expiresAt as string, startWatermark: s.startWatermark as string, endWatermark: s.endWatermark as string, records, counts, recordHashes };
}
