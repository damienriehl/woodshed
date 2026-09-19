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

import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

function localGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, `git ${args[0]}: ${result.stderr}`);
  return result.stdout;
}

test("real Git history scan finds deleted synthetic data while tracked and worktree scans stay clean", async t => {
  const root = await fixture({ "history.txt": "contact: synthetic.person@" + "coverage.invalid" });
  t.after(() => rm(root, { recursive: true, force: true }));
  localGit(root, ["init", "--quiet"]);
  localGit(root, ["add", "history.txt"]);
  localGit(root, ["-c", "user.name=Synthetic Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "synthetic history fixture"]);
  await writeFile(path.join(root, "history.txt"), "synthetic safe text");
  localGit(root, ["add", "history.txt"]);
  localGit(root, ["-c", "user.name=Synthetic Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "remove synthetic fixture value"]);
  const current = await runPrivacyScan({ cwd: root, modes: new Set(["--tracked", "--worktree"]) });
  assert.deepEqual(current, { findings: [], errors: [] });
  const history = await runPrivacyScan({ cwd: root, modes: new Set(["--history"]) });
  assert.deepEqual(history, { findings: [{ path: "history:history.txt", rule: "email" }], errors: [] });
  assert.doesNotMatch(JSON.stringify(history), /synthetic\.person/);
});

test("Git inventory failure is reported as a sanitized error", async t => {
  const root = await fixture({ "safe.txt": "synthetic safe text" });
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runPrivacyScan({ cwd: root, modes: new Set(["--tracked"]) });
  assert.deepEqual(result, { findings: [], errors: [{ path: "repository", error: "inventory-failed" }] });
});

test("explicit privacy paths resolve both relative and absolute inputs", async t => {
  const root = await fixture({ "safe.txt": "synthetic safe text", "other.txt": "contact: person@" + "coverage.invalid" });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await runPrivacyScan({ cwd: root, modes: new Set(), explicit: ["safe.txt"] }), { findings: [], errors: [] });
  const result = await runPrivacyScan({ cwd: root, modes: new Set(), explicit: [path.join(root, "other.txt")] });
  assert.deepEqual(result.findings, [{ path: path.join(root, "other.txt"), rule: "email" }]);
  assert.deepEqual(result.errors, []);
});

test("scanner excludes dependency and Git internals but still checks forbidden binary filenames", async t => {
  const root = await fixture({ "node_modules/ignored.txt": "person@" + "coverage.invalid", ".git/ignored.txt": "person@" + "coverage.invalid", "nested/export.db": Buffer.from([0, 1, 2]) });
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await scanPaths([root]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.findings, [{ path: path.join(root, "nested/export.db"), rule: "forbidden-artifact" }]);
});

test("manifest walks nested files and reports missing paths while excluding tool internals", async t => {
  const root = await fixture({ "nested/reviewed.txt": "safe", "node_modules/ignored.txt": "safe", ".git/ignored.txt": "safe" });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await verifyManifest(root, ["nested/reviewed.txt", "absent.txt"]), { unexpected: [], missing: ["absent.txt"] });
  await assert.rejects(verifyManifest(path.join(root, "missing"), []), { code: "ENOENT" });
});

function runPrivacyCli(script, root, args = []) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../../tools/privacy/${script}`, import.meta.url)), ...args], { cwd: root, encoding: "utf8" });
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

test("privacy CLI default and explicit modes report pass or sanitized failure with real exit codes", async t => {
  const root = await fixture({ "safe.txt": "synthetic safe text" });
  t.after(() => rm(root, { recursive: true, force: true }));
  const clean = runPrivacyCli("scan.mjs", root);
  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /Privacy scan passed/);
  const missing = runPrivacyCli("scan.mjs", root, ["missing.txt"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /privacy scan error: unreadable/);
  await writeFile(path.join(root, "unsafe.txt"), "person@" + "coverage.invalid");
  const unsafe = runPrivacyCli("scan.mjs", root, ["--worktree"]);
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stderr, /privacy finding: email/);
  assert.doesNotMatch(unsafe.stderr, /person@/);
});

test("manifest CLI verifies real files and fails when required paths disappear or unreviewed paths appear", async t => {
  const root = await fixture({ "safe.txt": "safe", "tools/privacy/public-files.json": JSON.stringify({ files: ["safe.txt", "tools/privacy/public-files.json"] }) });
  t.after(() => rm(root, { recursive: true, force: true }));
  const clean = runPrivacyCli("check-manifest.mjs", root);
  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /Public file manifest passed/);
  await rm(path.join(root, "safe.txt"));
  await writeFile(path.join(root, "unreviewed.txt"), "synthetic safe text");
  const failed = runPrivacyCli("check-manifest.mjs", root);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /unreviewed public path: unreviewed.txt/);
  assert.match(failed.stderr, /manifest path is missing: safe.txt/);
});
