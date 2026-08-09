export type DataClassification = {
  access: readonly string[];
  telemetry: "allowed" | "metadata-only" | "prohibited";
  retention: string;
  deletion: string;
  exportable: boolean;
};

export const DATA_CLASSIFICATIONS: Readonly<Record<string, DataClassification>> = Object.freeze({
  publicMetadata: { access: ["public"], telemetry: "allowed", retention: "while-published", deletion: "organizer-unpublish", exportable: true },
  personalData: { access: ["subject", "authorized-organizer"], telemetry: "prohibited", retention: "purpose-bounded", deletion: "subject-or-policy", exportable: true },
  privateProfile: { access: ["subject"], telemetry: "prohibited", retention: "until-deleted", deletion: "subject", exportable: true },
  ballot: { access: ["subject", "aggregate-reader"], telemetry: "metadata-only", retention: "event-policy", deletion: "event-policy", exportable: true },
  authenticationMaterial: { access: ["authentication-service"], telemetry: "prohibited", retention: "shortest-operational-window", deletion: "expiry-or-revocation", exportable: false },
  audit: { access: ["authorized-auditor"], telemetry: "metadata-only", retention: "declared-audit-window", deletion: "policy-after-hold", exportable: true },
});
