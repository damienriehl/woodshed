import { ContractValidationError, canonicalSongId, type CanonicalSongId } from "../../contracts/src/index.ts";

export type BallotVersion = { revision: number; rankings: readonly CanonicalSongId[] };

export function replaceBallot(previous: BallotVersion | undefined, input: { rankings: readonly string[]; eligibleSongIds: readonly string[] }) {
  const eligible = new Set(input.eligibleSongIds.map(canonicalSongId));
  const rankings = input.rankings.map(canonicalSongId);
  if (new Set(rankings).size !== rankings.length) throw new ContractValidationError("ballot rankings must be unique");
  if (rankings.some((song) => !eligible.has(song))) throw new ContractValidationError("ballot contains an ineligible song");
  return { method: "ranked-choice" as const, current: { revision: (previous?.revision ?? 0) + 1, rankings } };
}

export function appendEligibleCandidate(order: readonly string[], songId: string): CanonicalSongId[] {
  const current = order.map(canonicalSongId);
  const candidate = canonicalSongId(songId);
  return current.includes(candidate) ? current : [...current, candidate];
}
