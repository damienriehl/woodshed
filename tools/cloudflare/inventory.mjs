const TOP_LEVEL_FIELDS = ["environment", "expectedSourceSha", "forbidden", "staging"];
const STAGING_FIELDS = ["accountId", "databaseId", "databaseName", "origin", "workerName"];
const FORBIDDEN_FIELDS = ["accountIds", "databaseIds", "origins", "workerNames"];
const FULL_SHA = /^[a-f0-9]{40,64}$/i;
const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const DATABASE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PLACEHOLDER = /(?:replace|placeholder|example|configure|insert|change[-_ ]?me|required)/i;
const PROTECTED_NAME = /(?:production|prod(?:uction)?(?:-|$)|hootenanny)/i;

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value;
}

function rejectUnknown(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`unknown field in ${field}: ${unknown.join(", ")}`);
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  if (PLACEHOLDER.test(value)) throw new Error(`${field} contains a placeholder`);
  return value;
}

function nonemptyStringArray(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${field} must be a non-empty array of non-empty strings`);
  }
  return value;
}

function optionalDatabaseId(value, field) {
  if (value === undefined) return undefined;
  const databaseId = requiredString(value, field).toLowerCase();
  if (!DATABASE_ID.test(databaseId)) throw new Error(`${field} has an invalid shape`);
  return databaseId;
}

function normalizedOrigin(value, field) {
  const raw = requiredString(value, field);
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${field} must be an absolute HTTPS origin`); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${field} must be an absolute HTTPS origin`);
  }
  return url.origin;
}

function assertNotProtected(value, field) {
  if (PROTECTED_NAME.test(value)) throw new Error(`${field} identifies a production or Hootenanny target`);
}

export function validateStagingInventory(input, sourceState) {
  const inventory = object(input, "inventory");
  rejectUnknown(inventory, TOP_LEVEL_FIELDS, "inventory");
  const staging = object(inventory.staging, "staging");
  const forbidden = object(inventory.forbidden, "forbidden");
  rejectUnknown(staging, STAGING_FIELDS, "staging");
  rejectUnknown(forbidden, FORBIDDEN_FIELDS, "forbidden");

  if (inventory.environment !== "staging") throw new Error("environment must be explicit staging");
  const expectedSourceSha = requiredString(inventory.expectedSourceSha, "expectedSourceSha");
  const actualSourceSha = requiredString(sourceState?.actualSourceSha, "actual full source SHA");
  if (!FULL_SHA.test(expectedSourceSha) || !FULL_SHA.test(actualSourceSha)) throw new Error("expected and actual values must be full source SHAs");
  if (!sourceState?.worktreeClean) throw new Error("staging requires a clean worktree");
  if (expectedSourceSha.toLowerCase() !== actualSourceSha.toLowerCase()) throw new Error("expected source SHA must match the checked-out source SHA");

  const accountId = requiredString(staging.accountId, "staging.accountId").toLowerCase();
  const databaseId = optionalDatabaseId(staging.databaseId, "staging.databaseId");
  const databaseName = requiredString(staging.databaseName, "staging.databaseName").toLowerCase();
  const origin = normalizedOrigin(staging.origin, "staging.origin");
  const workerName = requiredString(staging.workerName, "staging.workerName");
  if (!ACCOUNT_ID.test(accountId)) throw new Error("staging.accountId has an invalid shape");
  if (!WORKER_NAME.test(databaseName) || !databaseName.includes("staging")) throw new Error("staging.databaseName must be a safe name containing staging");
  if (!WORKER_NAME.test(workerName) || !workerName.includes("staging")) throw new Error("staging.workerName must be a safe name containing staging");
  assertNotProtected(workerName, "staging.workerName");
  assertNotProtected(databaseName, "staging.databaseName");
  assertNotProtected(origin, "staging.origin");
  if (!origin.includes("staging") && !origin.endsWith(".workers.dev")) throw new Error("staging.origin must be unmistakably staging or workers.dev");

  const forbiddenAccountIds = nonemptyStringArray(forbidden.accountIds, "forbidden.accountIds").map((value) => value.toLowerCase());
  const forbiddenDatabaseIds = nonemptyStringArray(forbidden.databaseIds, "forbidden.databaseIds").map((value) => value.toLowerCase());
  const forbiddenOrigins = nonemptyStringArray(forbidden.origins, "forbidden.origins").map((value) => normalizedOrigin(value, "forbidden.origins"));
  const forbiddenWorkerNames = nonemptyStringArray(forbidden.workerNames, "forbidden.workerNames").map((value) => value.toLowerCase());
  if (forbiddenAccountIds.some((value) => !ACCOUNT_ID.test(value))) throw new Error("forbidden.accountIds contains an invalid account ID");
  if (forbiddenDatabaseIds.some((value) => !DATABASE_ID.test(value))) throw new Error("forbidden.databaseIds contains an invalid database ID");
  if (forbiddenWorkerNames.some((value) => !WORKER_NAME.test(value))) throw new Error("forbidden.workerNames contains an invalid Worker name");
  if (forbiddenAccountIds.includes(accountId)) throw new Error("staging account is forbidden");
  if (databaseId && forbiddenDatabaseIds.includes(databaseId)) throw new Error("staging database is forbidden");
  if (forbiddenOrigins.includes(origin)) throw new Error("staging origin is forbidden");
  if (forbiddenWorkerNames.includes(workerName)) throw new Error("staging Worker is forbidden");

  return Object.freeze({
    environment: "staging", expectedSourceSha,
    staging: Object.freeze({ accountId, databaseId, databaseName, origin, workerName }),
    forbidden: Object.freeze({
      accountIds: Object.freeze([...forbiddenAccountIds]), databaseIds: Object.freeze([...forbiddenDatabaseIds]),
      origins: Object.freeze([...forbiddenOrigins]), workerNames: Object.freeze([...forbiddenWorkerNames]),
    }),
  });
}

export function parseStructuredInventory(output, { commandSucceeded = true } = {}) {
  if (!commandSucceeded) throw new Error("Cloudflare inventory command failed");
  let parsed;
  try { parsed = typeof output === "string" ? JSON.parse(output) : output; } catch { throw new Error("Cloudflare inventory output is malformed"); }
  if (!Array.isArray(parsed)) throw new Error("Cloudflare inventory output must be an array");
  return parsed;
}

export function describeInventoryFields() {
  return {
    environment: "configured", expectedSourceSha: "configured",
    staging: [...STAGING_FIELDS], forbidden: [...FORBIDDEN_FIELDS],
  };
}
