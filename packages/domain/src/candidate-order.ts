import { createHash } from "node:crypto";

function score(participationId: string, songId: string): string {
  return createHash("sha256").update(`${participationId}\0${songId}`).digest("hex");
}

export function stableCandidateOrder(participationId: string, eligibleSongIds: readonly string[], priorOrder: readonly string[] = []): string[] {
  const eligible = new Set(eligibleSongIds);
  const retained = priorOrder.filter((id) => eligible.has(id));
  const known = new Set(retained);
  const additions = [...eligible]
    .filter((id) => !known.has(id))
    .map((id) => ({ id, score: score(participationId, id) }))
    .sort((a, b) => a.score.localeCompare(b.score) || a.id.localeCompare(b.id))
    .map(({ id }) => id);
  return [...retained, ...additions];
}
