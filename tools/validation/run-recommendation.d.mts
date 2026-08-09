import type { RecommendationInput, RecommendationReport } from "../../packages/graduation/src/index.ts";

export type RecommendationEvidence = RecommendationReport & {
  artifactVersion: 1;
  datasetKind: "synthetic";
  containsPrivateData: false;
  generatedAt: string;
};

export function runRecommendationValidation(inputPath: string, outputPath: string): Promise<RecommendationEvidence>;
