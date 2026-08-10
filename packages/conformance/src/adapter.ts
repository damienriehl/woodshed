export type FirstLoopIds = {
  community: string;
  otherCommunity: string;
  event: string;
  participation: string;
  songA: string;
  songB: string;
  songC: string;
};

export const KERNEL_ERROR_CODES = [
  "invalid-command",
  "denied",
  "expired",
  "not-yet-valid",
  "conflict",
  "voting-closed",
  "replay-mismatch",
  "invalid-ballot",
  "storage-failure",
] as const;

export type KernelErrorCode = typeof KERNEL_ERROR_CODES[number];

export class KernelError extends Error {
  readonly code: KernelErrorCode;

  constructor(code: KernelErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KernelError";
    this.code = code;
  }
}

export type BallotResult = {
  method: "ranked-choice";
  revision: number;
  rankings: string[];
};

export type FailurePoint = "after-state" | "after-audit";

export type FirstLoopStorage = {
  migrate(): Promise<void> | void;
  seedSyntheticFirstLoop(ids: FirstLoopIds): Promise<void> | void;
  replaceBallot(
    envelope: unknown,
    rankings: readonly string[],
    now?: Date,
    failurePoint?: FailurePoint,
  ): Promise<BallotResult> | BallotResult;
  count(table: "schema_migrations" | "communities" | "ballot_versions" | "audit_events" | "idempotency_receipts"): Promise<number> | number;
  revokeParticipation(id: string, at: string): Promise<void> | void;
  latestBallotCreatedAt(): Promise<string | undefined> | string | undefined;
  invariantViolations(): Promise<{ invariant: string; count: number }[]> | { invariant: string; count: number }[];
  close(): Promise<void> | void;
};
