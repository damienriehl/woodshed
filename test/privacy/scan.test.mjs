import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPrivacyScan } from "../../tools/privacy/scan.mjs";
import { verifyManifest } from "../../tools/privacy/check-manifest.mjs";
import { scanBuffer, scanPaths } from "../../tools/privacy/scanner.mjs";

async function fixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "woodshed-privacy-"));
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

test("accepts clean synthetic fixtures and allowlisted placeholders", async () => {
  const root = await fixture({
    "person.json": JSON.stringify({ name: "Avery Example", email: "person@example.com" }),
    ".env.example": "PUBLIC_ORIGIN=https://example.com\n",
  });

  const result = await scanPaths([root], { allowExamplePlaceholders: true });
  assert.deepEqual(result.findings, []);
  assert.equal(result.errors.length, 0);
});

test("an allowed placeholder does not hide another email in the same file", async () => {
  const syntheticEmail = "river.song@" + "people.test.invalid";
  const root = await fixture({
    "mixed.txt": `example: person@example.com\ncontact: ${syntheticEmail}\n`,
  });

  const result = await scanPaths([root], { allowExamplePlaceholders: true });
  assert.equal(result.findings.some(({ rule }) => rule === "email"), true);
});

for (const [label, contents, expectedRule] of [
  ["email", "contact: river.song@" + "people.test.invalid", "email"],
  ["phone", "call +1 (612) " + "555-0198", "phone"],
  ["postal address", "ship to 1847 Cedar " + "Street, Minneapolis, MN 55403", "postal-address"],
  ["bearer token", "Authorization: Bearer " + "abcdefghijklmnopqrstuvwxyz012345", "bearer-token"],
  ["capability token", "invite_" + "token=2PsLeXc7YwQm9N4b8Hk3T6vR", "capability-token"],
  ["private host", "https://admin.hoot" + "enanny.in" + "ternal/events", "private-host"],
]) {
  test(`rejects representative ${label} without echoing its value`, async () => {
    const root = await fixture({ "unsafe.txt": contents });
    const result = await scanPaths([root]);

    assert.equal(result.findings[0]?.rule, expectedRule);
    assert.equal(JSON.stringify(result).includes(contents), false);
  });
}

for (const filename of ["invitees.generated.sql", "production.sqlite", "release.tar.gz", "people.backup.json"]) {
  test(`rejects generated or backup artifact ${filename}`, async () => {
    const root = await fixture({ [filename]: "synthetic contents only" });
    const result = await scanPaths([root]);
    assert.equal(result.findings[0]?.rule, "forbidden-artifact");
  });
}

test("scans ignored and build-style directories while skipping binary contents safely", async () => {
  const syntheticEmail = "private.person@" + "community.test.invalid";
  const root = await fixture({
    "dist/leak.txt": `contact: ${syntheticEmail}`,
    "coverage/raw.bin": Buffer.from([0, 1, 2, 3, 255]),
  });
  const result = await scanPaths([root]);
  assert.equal(result.findings.some(({ path: file }) => file.endsWith("dist/leak.txt")), true);
  assert.equal(result.errors.length, 0);
});

test("fails closed when a requested path cannot be read", async () => {
  const root = await fixture({ "clean.txt": "synthetic only" });
  const missing = path.join(root, "missing");
  const result = await scanPaths([missing]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, missing);
});

test("fails closed on symbolic links instead of following or ignoring them", async () => {
  const root = await fixture({ "target.txt": "synthetic only" });
  await symlink("target.txt", path.join(root, "link.txt"));

  const result = await scanPaths([root]);
  assert.equal(result.errors.length, 1);
});

test("tracked inventory scans indexed files without printing sensitive contents", async () => {
  const syntheticToken = "abcdefghijklmnopqrstuvwxyz" + "012345";
  const root = await fixture({ "tracked.txt": `Authorization: Bearer ${syntheticToken}` });
  const result = await runPrivacyScan({
    cwd: root,
    modes: new Set(["--tracked"]),
    git: () => Buffer.from("tracked.txt\0"),
  });
  assert.equal(result.findings[0]?.rule, "bearer-token");
  assert.equal(JSON.stringify(result).includes(syntheticToken), false);
});

test("worktree inventory includes ignored build outputs", async () => {
  const syntheticCapability = "2PsLeXc7YwQm9N4b" + "8Hk3T6vR";
  const root = await fixture({
    ".gitignore": "dist/\n",
    "dist/output.txt": `invite_token=${syntheticCapability}`,
  });
  const result = await runPrivacyScan({ cwd: root, modes: new Set(["--worktree"]) });
  assert.equal(result.findings.some(({ path: file }) => file.endsWith("dist/output.txt")), true);
});

test("public manifest fails closed on a file that was not reviewed", async () => {
  const root = await fixture({ "reviewed.txt": "safe", "surprise.txt": "safe" });
  const result = await verifyManifest(root, ["reviewed.txt"]);
  assert.deepEqual(result.unexpected, ["surprise.txt"]);
  assert.deepEqual(result.missing, []);
});

test("does not confuse an archive source directory with an exported archive artifact", () => {
  const result = scanBuffer("packages/archive/package.json", Buffer.from('{"name":"archive-contract"}'));
  assert.deepEqual(result, []);
});
