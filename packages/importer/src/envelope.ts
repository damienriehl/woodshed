import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";
import { canonicalJson, parseNeutralSnapshot, type NeutralSnapshot } from "../../contracts/src/snapshot.ts";

export type SecureSnapshotEnvelope = { envelopeVersion: 1; schemaVersion:1; profile:string; snapshotId:string; sourceIdentity:string; destinationCommunityId: string; createdAt: string; expiresAt: string; recipientKeyId: string; ephemeralPublicKey: string; wrapIv: string; wrappedKey: string; wrapTag: string; payloadIv: string; ciphertext: string; payloadTag: string };
const b64 = (b: Buffer | ArrayBuffer) => (Buffer.isBuffer(b) ? b : Buffer.from(b)).toString("base64");
const keyId = (key: KeyObject) => createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex").slice(0, 24);
const aad = (e: Pick<SecureSnapshotEnvelope,"envelopeVersion"|"schemaVersion"|"profile"|"snapshotId"|"sourceIdentity"|"destinationCommunityId"|"createdAt"|"expiresAt"|"recipientKeyId">) => Buffer.from(canonicalJson(e));
const crypt = (key: Buffer, iv: Buffer, plain: Buffer, additional: Buffer) => { const c=createCipheriv("aes-256-gcm",key,iv); c.setAAD(additional); return { data:Buffer.concat([c.update(plain),c.final()]),tag:c.getAuthTag() }; };
const MAX_CIPHERTEXT_BYTES = 32 * 1024 * 1024;
const MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;
function decodeBase64(value:string,label:string,maxBytes:number){
  if(typeof value!=="string"||value.length>Math.ceil(maxBytes*4/3)+4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value)||value.length%4!==0)throw new Error(`snapshot ${label} is invalid or too large`);
  const decoded=Buffer.from(value,"base64");if(decoded.length>maxBytes||decoded.toString("base64")!==value)throw new Error(`snapshot ${label} is invalid or too large`);return decoded;
}

export function createEnvelope(snapshotValue: NeutralSnapshot, options: { recipientPublicKey: KeyObject; destinationCommunityId: string; now?: Date }): SecureSnapshotEnvelope {
  const snapshot = parseNeutralSnapshot(snapshotValue);
  if (snapshot.destinationCommunityId !== options.destinationCommunityId) throw new Error("snapshot destination mismatch");
  if ((options.now??new Date()).getTime()>=Date.parse(snapshot.expiresAt)) throw new Error("snapshot expired");
  const ephemeral = generateKeyPairSync("x25519"), salt=randomBytes(32), shared=diffieHellman({privateKey:ephemeral.privateKey,publicKey:options.recipientPublicKey});
  const wrapping=Buffer.from(hkdfSync("sha256",shared,salt,Buffer.from("woodshed-snapshot-key-wrap-v1"),32)), dek=randomBytes(32), wrapIv=randomBytes(12), payloadIv=randomBytes(12);
  const header={envelopeVersion:1 as const,schemaVersion:snapshot.schemaVersion,profile:snapshot.profile,snapshotId:snapshot.snapshotId,sourceIdentity:snapshot.sourceIdentity,destinationCommunityId:options.destinationCommunityId,createdAt:snapshot.createdAt,expiresAt:snapshot.expiresAt,recipientKeyId:keyId(options.recipientPublicKey)};
  const wrapped=crypt(wrapping,wrapIv,dek,aad(header)); const payload=crypt(dek,payloadIv,Buffer.from(canonicalJson(snapshot)),aad(header)); dek.fill(0);
  return {...header,ephemeralPublicKey:b64(ephemeral.publicKey.export({type:"spki",format:"der"})),wrapIv:b64(Buffer.concat([salt,wrapIv])),wrappedKey:b64(wrapped.data),wrapTag:b64(wrapped.tag),payloadIv:b64(payloadIv),ciphertext:b64(payload.data),payloadTag:b64(payload.tag)};
}

export function openEnvelope(e: SecureSnapshotEnvelope, options:{recipientPrivateKey:KeyObject;expectedDestinationCommunityId:string;now?:Date}): NeutralSnapshot {
  if (e.envelopeVersion!==1 || e.destinationCommunityId!==options.expectedDestinationCommunityId) throw new Error("snapshot destination mismatch");
  if ((options.now??new Date()).getTime()>=Date.parse(e.expiresAt)) throw new Error("snapshot expired");
  if(e.recipientKeyId!==keyId(createPublicKey(options.recipientPrivateKey)))throw new Error("snapshot recipient key mismatch");
  const publicKey=(awaitImportPublicKey)(decodeBase64(e.ephemeralPublicKey,"ephemeral public key",256));
  const shared=diffieHellman({privateKey:options.recipientPrivateKey,publicKey}); const packed=decodeBase64(e.wrapIv,"wrap IV",44),salt=packed.subarray(0,32),wrapIv=packed.subarray(32);
  if(packed.length!==44)throw new Error("snapshot wrap IV is invalid");
  const wrapping=Buffer.from(hkdfSync("sha256",shared,salt,Buffer.from("woodshed-snapshot-key-wrap-v1"),32)); const header={envelopeVersion:e.envelopeVersion,schemaVersion:e.schemaVersion,profile:e.profile,snapshotId:e.snapshotId,sourceIdentity:e.sourceIdentity,destinationCommunityId:e.destinationCommunityId,createdAt:e.createdAt,expiresAt:e.expiresAt,recipientKeyId:e.recipientKeyId};
  const unwrap=createDecipheriv("aes-256-gcm",wrapping,wrapIv); unwrap.setAAD(aad(header)); unwrap.setAuthTag(decodeBase64(e.wrapTag,"wrap tag",16)); const dek=Buffer.concat([unwrap.update(decodeBase64(e.wrappedKey,"wrapped key",32)),unwrap.final()]);
  try { const d=createDecipheriv("aes-256-gcm",dek,decodeBase64(e.payloadIv,"payload IV",12)); d.setAAD(aad(header)); d.setAuthTag(decodeBase64(e.payloadTag,"payload tag",16)); const plain=Buffer.concat([d.update(decodeBase64(e.ciphertext,"ciphertext",MAX_CIPHERTEXT_BYTES)),d.final()]);if(plain.length>MAX_PLAINTEXT_BYTES)throw new Error("snapshot plaintext size limit exceeded");const snapshot=parseNeutralSnapshot(JSON.parse(plain.toString("utf8")));if(snapshot.schemaVersion!==e.schemaVersion||snapshot.profile!==e.profile||snapshot.snapshotId!==e.snapshotId||snapshot.sourceIdentity!==e.sourceIdentity||snapshot.destinationCommunityId!==e.destinationCommunityId||snapshot.createdAt!==e.createdAt||snapshot.expiresAt!==e.expiresAt)throw new Error("snapshot envelope payload metadata mismatch");return snapshot; } finally { dek.fill(0); }
}
const awaitImportPublicKey=(value:Buffer)=>createPublicKey({key:value,type:"spki",format:"der"});
