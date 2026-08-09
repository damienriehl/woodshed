import { createHash } from "node:crypto";

type SongInput = { songId: string; title: string; demand: number; feasibility: number | null };
type RecommendationInput = {
  algorithmVersion: string;
  seed: string;
  weights: { demand: number; feasibility: number };
  songs: readonly SongInput[];
  overrideOrder?: readonly string[];
  overrideReason?: string;
};

export function recommendSetlist(input: RecommendationInput) {
  const inputSnapshot = createHash("sha256").update(JSON.stringify(input.songs)).digest("hex");
  const scored = input.songs.map((song) => ({
    songId: song.songId,
    title: song.title,
    score: song.demand * input.weights.demand + (song.feasibility ?? 0) * input.weights.feasibility,
    factors: {
      demand: { value: song.demand, weight: input.weights.demand },
      feasibility: song.feasibility === null
        ? { status: "unknown" as const, value: null, weight: input.weights.feasibility }
        : { status: "known" as const, value: song.feasibility, weight: input.weights.feasibility },
    },
  })).sort((a, b) => b.score - a.score || a.songId.localeCompare(b.songId));
  const byId = new Map(scored.map((item) => [item.songId, item]));
  const items = input.overrideOrder ? input.overrideOrder.map((id) => byId.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item)) : scored;
  return {
    items,
    explanation: {
      algorithmVersion: input.algorithmVersion,
      seed: input.seed,
      weights: input.weights,
      inputSnapshot,
      ...(input.overrideOrder ? { override: { order: [...input.overrideOrder], reason: input.overrideReason ?? "Organizer edit" } } : {}),
    },
  };
}
