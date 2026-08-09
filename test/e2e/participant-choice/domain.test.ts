import assert from "node:assert/strict";
import test from "node:test";

import { stableCandidateOrder } from "../../../packages/domain/src/candidate-order.ts";
import { recommendSetlist } from "../../../packages/recommendation/src/index.ts";

test("candidate order is participant-stable and appends later songs", () => {
  const initial = stableCandidateOrder("participation_alpha", ["song_alpha", "song_bravo"]);
  assert.deepEqual(stableCandidateOrder("participation_alpha", ["song_bravo", "song_alpha"]), initial);
  assert.deepEqual(stableCandidateOrder("participation_alpha", ["song_alpha", "song_bravo", "song_charlie"], initial), [...initial, "song_charlie"]);
});

test("recommendations are deterministic, explain unknown feasibility, and record overrides", () => {
  const input = {
    algorithmVersion: "draft-setlist/v1",
    seed: "event_alpha:v1",
    weights: { demand: 0.7, feasibility: 0.3 },
    songs: [
      { songId: "song_alpha", title: "North Star", demand: 0.5, feasibility: null },
      { songId: "song_bravo", title: "Open Road", demand: 0.4, feasibility: 0 },
    ],
  } as const;
  const first = recommendSetlist(input);
  assert.deepEqual(recommendSetlist(input), first);
  assert.equal(first.items[0]?.factors.feasibility.status, "unknown");
  assert.equal(first.items[1]?.factors.feasibility.status, "known");
  assert.equal(first.items[1]?.factors.feasibility.value, 0);
  const overridden = recommendSetlist({ ...input, overrideOrder: ["song_bravo", "song_alpha"], overrideReason: "Opener energy" });
  assert.equal(overridden.items[0]?.songId, "song_bravo");
  assert.equal(overridden.explanation.override?.reason, "Opener energy");
});
