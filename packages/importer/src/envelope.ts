import { createCipheriv, createDecipheriv, createHash, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";
import { canonicalJson, parseNeutralSnapshot, type NeutralSnapshot } from "../../contracts/src/snapshot.ts";

export type SecureSnapshotEnvelope = { envelopeVersion: 1; destinationCommunityId: string; createdAt: string; expiresAt: string; recipientKeyId: string; ephemeralPublicKey: string; wrapIv: string; wrappedKey: string; wrapTag: string; payloadIv: string; ciphertext: string; payloadTag: string };
const b64 = (b: Buffer | ArrayBuffer) => (Buffer.isBuffer(b) ? b : Buffer.from(b)).toString("base64");
const keyId = (key: KeyObject) => createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex").slice(0, 24);
const aad = (e: Pick<SecureSnapshotEnvelope,"envelopeVersion"|"destinationCommunityId"|"createdAt"|"expiresAt"|"recipientKeyId">) => Buffer.from(canonicalJson(e));
const crypt = (key: Buffer, iv: Buffer, plain: Buffer, additional: Buffer) => { const c=createCipheriv("aes-256-gcm",key,iv); c.setAAD(additional); return { data:Buffer.concat([c.update(plain),c.final()]),tag:c.getAuthTag() }; };

export function createEnvelope(snapshotValue: NeutralSnapshot, options: { recipientPublicKey: KeyObject; destinationCommunityId: string; now?: Date }): SecureSnapshotEnvelope {
  const snapshot = parseNeutralSnapshot(snapshotValue);
  if (snapshot.destinationCommunityId !== options.destinationCommunityId) throw new Error("snapshot destination mismatch");
  if ((options.now??new Date()).getTime()>=Date.parse(snapshot.expiresAt)) throw new Error("snapshot expired");
  const ephemeral = generateKeyPairSync("x25519"), salt=randomBytes(32), shared=diffieHellman({privateKey:ephemeral.privateKey,publicKey:options.recipientPublicKey});
  const wrapping=Buffer.from(hkdfSync("sha256",shared,salt,Buffer.from("woodshed-snapshot-key-wrap-v1"),32)), dek=randomBytes(32), wrapIv=randomBytes(12), payloadIv=randomBytes(12);
  const header={envelopeVersion:1 as const,destinationCommunityId:options.destinationCommunityId,createdAt:snapshot.createdAt,expiresAt:snapshot.expiresAt,recipientKeyId:keyId(options.recipientPublicKey)};
  const wrapped=crypt(wrapping,wrapIv,dek,aad(header)); const payload=crypt(dek,payloadIv,Buffer.from(canonicalJson(snapshot)),aad(header)); dek.fill(0);
  return {...header,ephemeralPublicKey:b64(ephemeral.publicKey.export({type:"spki",format:"der"})),wrapIv:b64(Buffer.concat([salt,wrapIv])),wrappedKey:b64(wrapped.data),wrapTag:b64(wrapped.tag),payloadIv:b64(payloadIv),ciphertext:b64(payload.data),payloadTag:b64(payload.tag)};
}

export function openEnvelope(e: SecureSnapshotEnvelope, options:{recipientPrivateKey:KeyObject;expectedDestinationCommunityId:string;now?:Date}): NeutralSnapshot {
  if (e.envelopeVersion!==1 || e.destinationCommunityId!==options.expectedDestinationCommunityId) throw new Error("snapshot destination mismatch");
  if ((options.now??new Date()).getTime()>=Date.parse(e.expiresAt)) throw new Error("snapshot expired");
  const publicKey=(awaitImportPublicKey)(e.ephemeralPublicKey);
  const shared=diffieHellman({privateKey:options.recipientPrivateKey,publicKey}); const packed=Buffer.from(e.wrapIv,"base64"),salt=packed.subarray(0,32),wrapIv=packed.subarray(32);
  const wrapping=Buffer.from(hkdfSync("sha256",shared,salt,Buffer.from("woodshed-snapshot-key-wrap-v1"),32)); const header={envelopeVersion:e.envelopeVersion,destinationCommunityId:e.destinationCommunityId,createdAt:e.createdAt,expiresAt:e.expiresAt,recipientKeyId:e.recipientKeyId};
  const unwrap=createDecipheriv("aes-256-gcm",wrapping,wrapIv); unwrap.setAAD(aad(header)); unwrap.setAuthTag(Buffer.from(e.wrapTag,"base64")); const dek=Buffer.concat([unwrap.update(Buffer.from(e.wrappedKey,"base64")),unwrap.final()]);
  try { const d=createDecipheriv("aes-256-gcm",dek,Buffer.from(e.payloadIv,"base64")); d.setAAD(aad(header)); d.setAuthTag(Buffer.from(e.payloadTag,"base64")); return parseNeutralSnapshot(JSON.parse(Buffer.concat([d.update(Buffer.from(e.ciphertext,"base64")),d.final()]).toString("utf8"))); } finally { dek.fill(0); }
}
import { createPublicKey } from "node:crypto";
const awaitImportPublicKey=(value:string)=>createPublicKey({key:Buffer.from(value,"base64"),type:"spki",format:"der"});
