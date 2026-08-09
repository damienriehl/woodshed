#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateRecommendation } from "../../packages/graduation/src/index.ts";

export async function runRecommendationValidation(inputPath, outputPath) {
  if (!inputPath || !outputPath) throw new Error("usage: validate:recommendation -- input.json evidence.json");
  const source = JSON.parse(await readFile(inputPath, "utf8"));
  if (source.datasetKind !== "synthetic" || source.containsPrivateData !== false) throw new Error("only declared synthetic, privacy-safe validation input is accepted");
  const report = validateRecommendation(source);
  const evidence = { artifactVersion: 1, datasetKind: "synthetic", containsPrivateData: false, generatedAt: source.evidenceTime, ...report };
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runRecommendationValidation(process.argv[2], process.argv[3]).catch(error => { console.error(error instanceof Error ? error.message : "validation failed"); process.exitCode = 1; });
