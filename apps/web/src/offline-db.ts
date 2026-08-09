import { OfflineOutbox, type OfflineCheckpoint, type OfflineStore, type OutboxStatus, type SyncTrigger } from "../../../packages/application/src/offline.ts";
import type { LiveCommand } from "../../../packages/application/src/live-service.ts";

const DATABASE = "woodshed-live-v1";
const STORE = "records";
const CHECKPOINT_EXPIRY = "9999-12-31T23:59:59.999Z";
type Stored = { key: string; eventId: string; kind: "operation" | "checkpoint"; value: unknown; expiresAt: string };

function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("eventId", "eventId");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, setResult: (value: T) => void, reject: (reason?: unknown) => void) => void) {
  const database = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      let result: T;
      work(transaction.objectStore(STORE), value => { result = value; }, reject);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export class BrowserOfflineStore implements OfflineStore {
  private readonly channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("woodshed-live");

  async putOperation(command: LiveCommand) {
    await this.put({ key: `operation:${command.operationId}`, eventId: command.eventId, kind: "operation", value: command, expiresAt: command.expiresAt });
  }

  async operations() {
    const records = await this.records();
    const now = Date.now();
    const expired = records.filter((record) => record.kind === "operation" && Date.parse(record.expiresAt) <= now);
    await Promise.all(expired.map((record) => this.deleteKey(record.key)));
    return records
      .filter((record) => record.kind === "operation" && Date.parse(record.expiresAt) > now)
      .map((record) => structuredClone(record.value as LiveCommand));
  }

  async deleteOperation(operationId: string) {
    await this.deleteKey(`operation:${operationId}`);
  }

  async putCheckpoint(eventId: string, value: OfflineCheckpoint) {
    await this.put({ key: `checkpoint:${eventId}`, eventId, kind: "checkpoint", value, expiresAt: CHECKPOINT_EXPIRY });
  }

  async checkpoint(eventId: string) {
    const record = await this.get(`checkpoint:${eventId}`);
    return record ? structuredClone(record.value as OfflineCheckpoint) : null;
  }

  async purgeEvent(eventId: string) {
    await transact<void>("readwrite", (store, setResult) => {
      const request = store.index("eventId").openCursor(IDBKeyRange.only(eventId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else setResult();
      };
    });
    this.channel?.postMessage({ type: "event-purged", eventId });
  }

  async clear() {
    await transact<void>("readwrite", (store, setResult) => {
      const request = store.clear();
      request.onsuccess = () => setResult();
    });
    this.channel?.postMessage({ type: "device-cleared" });
  }

  close() {
    this.channel?.close();
  }

  private async put(record: Stored) {
    await transact<void>("readwrite", (store, setResult) => {
      const request = store.put(record);
      request.onsuccess = () => setResult();
    });
    this.channel?.postMessage({ type: "offline-store-changed", eventId: record.eventId });
  }

  private get(key: string) {
    return transact<Stored | null>("readonly", (store, setResult) => {
      const request = store.get(key);
      request.onsuccess = () => setResult((request.result as Stored | undefined) ?? null);
    });
  }

  private records() {
    return transact<Stored[]>("readonly", (store, setResult) => {
      const request = store.getAll();
      request.onsuccess = () => setResult(request.result as Stored[]);
    });
  }

  private deleteKey(key: string) {
    return transact<void>("readwrite", (store, setResult) => {
      const request = store.delete(key);
      request.onsuccess = () => setResult();
    });
  }
}

export function installForegroundSyncTriggers(sync: (trigger: SyncTrigger) => void) {
  sync("startup");
  globalThis.addEventListener("online", () => sync("online"));
  globalThis.addEventListener("focus", () => sync("focus"));
}

export function installOfflineRuntime(send: (command: LiveCommand) => Promise<Exclude<OutboxStatus, "delayed">>) {
  const store = new BrowserOfflineStore();
  const outbox = new OfflineOutbox(store);
  const sync = (trigger: SyncTrigger) => void outbox.sync(trigger, send);
  installForegroundSyncTriggers(sync);
  return { store, outbox, sync: () => sync("manual") };
}
