import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const fixture = JSON.parse(await readFile("test/fixtures/synthetic/community.json", "utf8"));
assert.match(fixture.communityId, /^community_example_/);
assert.equal(fixture.events[0].visibility, "public");
assert.equal(fixture.organizer.email, "person@example.com");
console.log("Foundation build verification passed.");
