import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual, type KeyObject } from "node:crypto";
import { canonicalJson } from "../../contracts/src/snapshot.ts";

export const COMMUNITY_ARCHIVE_PROFILE="woodshed/community-archive/v1" as const;
const SUPPORTED_SCHEMA=1;
const MAX_RECORDS=100_000, MAX_ASSETS=10_000, MAX_DEPTH=64, MAX_DECOMPRESSED_BYTES=256*1024*1024;
const MAX_ARCHIVE_LIFETIME_MS=7*24*60*60_000;
const CONSENT_SCOPES=new Set(["community","event-only","private-profile","withdrawn"]);
export type ArchiveRecord={type:string;id:string;parentId:string|null;tombstone:boolean;consentScope:string;attributes:Record<string,unknown>};
export type ArchiveAsset={id:string;sha256:string;authorizedForExport:boolean};
export type AuditLink={sequence:number;previousHash:string|null;hash:string};
export type CommunityArchive={archiveId:string;sourceCommunityId:string;destinationCommunityId:string;createdAt:string;expiresAt:string;schemaVersion:number;records:ArchiveRecord[];assets:ArchiveAsset[];audit:AuditLink[]};
export type CommunityArchiveEnvelope={envelopeVersion:1;profile:typeof COMMUNITY_ARCHIVE_PROFILE;schemaVersion:number;archiveId:string;sourceCommunityId:string;destinationCommunityId:string;createdAt:string;expiresAt:string;recipientKeyId:string;ephemeralPublicKey:string;wrapIv:string;wrappedKey:string;wrapTag:string;payloadIv:string;ciphertext:string;payloadTag:string};
export interface KeyCustodyPort { generateDataKey():Buffer; destroyDataKey(key:Buffer):void }
export class MemoryKeyCustody implements KeyCustodyPort { generateDataKey(){return randomBytes(32)} destroyDataKey(key:Buffer){key.fill(0)} }
export interface DownloadAuthorizationPort { sign(value:string):string; verify(value:string,signature:string):boolean }
export class MemoryDownloadAuthorizer implements DownloadAuthorizationPort {
  private readonly key=randomBytes(32);
  sign(value:string){return createHmac("sha256",this.key).update(value).digest("hex")}
  verify(value:string,signature:string){const expected=this.sign(value),left=Buffer.from(expected),right=Buffer.from(signature);return left.length===right.length&&timingSafeEqual(left,right)}
}
export class BoundedEncryptedArchiveBuffer {
  private readonly chunks:Buffer[]=[]; private size=0;
  private readonly maxBytes:number;
  constructor(maxBytes=32*1024*1024){this.maxBytes=maxBytes}
  push(chunk:Uint8Array){if(chunk.byteLength===0)return;if(this.size+chunk.byteLength>this.maxBytes){this.clear();throw new Error("encrypted archive stream size limit exceeded")}this.chunks.push(Buffer.from(chunk));this.size+=chunk.byteLength}
  finish(){const value=Buffer.concat(this.chunks,this.size);this.clear();return value}
  clear(){for(const chunk of this.chunks)chunk.fill(0);this.chunks.length=0;this.size=0}
}
const b64=(value:Buffer|ArrayBuffer)=>Buffer.from(value instanceof ArrayBuffer?new Uint8Array(value):value).toString("base64");
const recipientId=(key:KeyObject)=>createHash("sha256").update(key.export({type:"spki",format:"der"})).digest("hex").slice(0,24);
const aad=(value:Pick<CommunityArchiveEnvelope,"envelopeVersion"|"profile"|"schemaVersion"|"archiveId"|"sourceCommunityId"|"destinationCommunityId"|"createdAt"|"expiresAt"|"recipientKeyId">)=>Buffer.from(canonicalJson(value));
function encrypted(key:Buffer,iv:Buffer,plaintext:Buffer,header:Buffer){const cipher=createCipheriv("aes-256-gcm",key,iv);cipher.setAAD(header);return{ciphertext:Buffer.concat([cipher.update(plaintext),cipher.final()]),tag:cipher.getAuthTag()}}

export function validateArchiveEntryName(name:string){
  if(!name || name.length>255 || name.includes("\0") || name.includes("\\") || name.startsWith("/") || name.split("/").some(part=>part===".."||part==="."||part==="")) throw new Error("invalid archive entry name");
}
function validateValue(value:unknown,depth=0):number {
  if(depth>MAX_DEPTH)throw new Error("archive nesting depth exceeded");
  if(value===null||typeof value==="string"||typeof value==="boolean"||typeof value==="number")return Buffer.byteLength(JSON.stringify(value));
  if(Array.isArray(value))return value.reduce((size,item)=>size+validateValue(item,depth+1),0);
  if(typeof value==="object")return Object.entries(value as Record<string,unknown>).reduce((size,[name,item])=>{validateArchiveEntryName(name);return size+Buffer.byteLength(name)+validateValue(item,depth+1)},0);
  throw new Error("unsupported archive value type");
}
export function validateCommunityArchive(value:CommunityArchive,now=new Date()):CommunityArchive {
  if(value.schemaVersion!==SUPPORTED_SCHEMA)throw new Error("unsupported archive schema");
  for(const field of ["archiveId","sourceCommunityId","destinationCommunityId","createdAt","expiresAt"] as const)if(typeof value[field]!=="string"||value[field]==="")throw new Error(`archive ${field} required`);
  if(!Number.isFinite(Date.parse(value.createdAt))||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=Date.parse(value.createdAt))throw new Error("invalid archive dates");
  if(now.getTime()>=Date.parse(value.expiresAt))throw new Error("archive expired");
  if(!Array.isArray(value.records)||value.records.length>MAX_RECORDS||!Array.isArray(value.assets)||value.assets.length>MAX_ASSETS||!Array.isArray(value.audit))throw new Error("archive resource limit exceeded");
  const ids=new Set<string>(); for(const record of value.records){if(!record||typeof record!=="object"||typeof record.type!=="string"||typeof record.id!=="string"||(record.parentId!==null&&typeof record.parentId!=="string")||typeof record.tombstone!=="boolean"||typeof record.consentScope!=="string"||!record.attributes||typeof record.attributes!=="object"||Array.isArray(record.attributes))throw new Error("invalid archive record type");validateArchiveEntryName(record.type);validateArchiveEntryName(record.id);if(!CONSENT_SCOPES.has(record.consentScope))throw new Error("unsupported consent scope");if(ids.has(record.id))throw new Error("duplicate archive record");ids.add(record.id);validateValue(record.attributes)}
  for(const record of value.records)if(record.parentId&&!ids.has(record.parentId))throw new Error("missing archive relationship");
  const byId=new Map(value.records.map(record=>[record.id,record]));for(const record of value.records){let current:ArchiveRecord|undefined=record,depth=0;const seen=new Set<string>();while(current?.parentId){if(seen.has(current.id))throw new Error("archive relationship cycle");seen.add(current.id);if(++depth>MAX_DEPTH)throw new Error("archive relationship depth exceeded");current=byId.get(current.parentId)}}
  for(const asset of value.assets){if(!asset||typeof asset!=="object"||typeof asset.id!=="string"||typeof asset.sha256!=="string"||typeof asset.authorizedForExport!=="boolean")throw new Error("invalid asset type");validateArchiveEntryName(asset.id);if(!/^[a-f0-9]{64}$/.test(asset.sha256)||!asset.authorizedForExport)throw new Error("unauthorized or invalid asset")}
  let previous:string|null=null; for(let i=0;i<value.audit.length;i++){const event=value.audit[i]!;if(!event||typeof event!=="object"||typeof event.sequence!=="number"||(event.previousHash!==null&&typeof event.previousHash!=="string")||typeof event.hash!=="string"||event.sequence!==i+1||event.previousHash!==previous||!/^[a-f0-9]{64}$/.test(event.hash))throw new Error("audit continuity invalid");previous=event.hash}
  if(validateValue(value)>MAX_DECOMPRESSED_BYTES)throw new Error("archive decompressed size limit exceeded");
  return structuredClone(value);
}

export function createCommunityArchive(value:CommunityArchive,options:{recipientPublicKey:KeyObject;keyCustody:KeyCustodyPort;now?:Date}):CommunityArchiveEnvelope {
  const archive=validateCommunityArchive(value,options.now); const ephemeral=generateKeyPairSync("x25519"),salt=randomBytes(32),wrapIv=randomBytes(12),payloadIv=randomBytes(12),dek=options.keyCustody.generateDataKey();
  const shared=diffieHellman({privateKey:ephemeral.privateKey,publicKey:options.recipientPublicKey}),wrapping=Buffer.from(hkdfSync("sha256",shared,salt,Buffer.from("woodshed-community-archive-wrap-v1"),32));
  const header={envelopeVersion:1 as const,profile:COMMUNITY_ARCHIVE_PROFILE,schemaVersion:archive.schemaVersion,archiveId:archive.archiveId,sourceCommunityId:archive.sourceCommunityId,destinationCommunityId:archive.destinationCommunityId,createdAt:archive.createdAt,expiresAt:archive.expiresAt,recipientKeyId:recipientId(options.recipientPublicKey)};
  try {const wrapped=encrypted(wrapping,wrapIv,dek,aad(header)),payload=encrypted(dek,payloadIv,Buffer.from(canonicalJson(archive)),aad(header));return{...header,ephemeralPublicKey:b64(ephemeral.publicKey.export({type:"spki",format:"der"})),wrapIv:b64(Buffer.concat([salt,wrapIv])),wrappedKey:b64(wrapped.ciphertext),wrapTag:b64(wrapped.tag),payloadIv:b64(payloadIv),ciphertext:b64(payload.ciphertext),payloadTag:b64(payload.tag)}}finally{options.keyCustody.destroyDataKey(dek)}
}
export function openCommunityArchive(envelope:CommunityArchiveEnvelope,options:{recipientPrivateKey:KeyObject;expectedDestinationCommunityId:string;now?:Date}):CommunityArchive {
  if(envelope.envelopeVersion!==1||envelope.profile!==COMMUNITY_ARCHIVE_PROFILE)throw new Error("unsupported archive envelope");
  if(envelope.destinationCommunityId!==options.expectedDestinationCommunityId)throw new Error("archive destination mismatch");
  if(envelope.recipientKeyId!==recipientId(createPublicKey(options.recipientPrivateKey)))throw new Error("archive recipient key mismatch");
  if((options.now??new Date()).getTime()>=Date.parse(envelope.expiresAt))throw new Error("archive expired");
  if(envelope.ciphertext.length>Math.ceil(MAX_DECOMPRESSED_BYTES*4/3)+4)throw new Error("archive compressed size limit exceeded");
  const ephemeral=createPublicKey({key:Buffer.from(envelope.ephemeralPublicKey,"base64"),type:"spki",format:"der"}),packed=Buffer.from(envelope.wrapIv,"base64"),salt=packed.subarray(0,32),iv=packed.subarray(32);
  const wrapping=Buffer.from(hkdfSync("sha256",diffieHellman({privateKey:options.recipientPrivateKey,publicKey:ephemeral}),salt,Buffer.from("woodshed-community-archive-wrap-v1"),32)),header={envelopeVersion:envelope.envelopeVersion,profile:envelope.profile,schemaVersion:envelope.schemaVersion,archiveId:envelope.archiveId,sourceCommunityId:envelope.sourceCommunityId,destinationCommunityId:envelope.destinationCommunityId,createdAt:envelope.createdAt,expiresAt:envelope.expiresAt,recipientKeyId:envelope.recipientKeyId};
  const unwrap=createDecipheriv("aes-256-gcm",wrapping,iv);unwrap.setAAD(aad(header));unwrap.setAuthTag(Buffer.from(envelope.wrapTag,"base64"));const dek=Buffer.concat([unwrap.update(Buffer.from(envelope.wrappedKey,"base64")),unwrap.final()]);
  try{const decrypt=createDecipheriv("aes-256-gcm",dek,Buffer.from(envelope.payloadIv,"base64"));decrypt.setAAD(aad(header));decrypt.setAuthTag(Buffer.from(envelope.payloadTag,"base64"));const bytes=Buffer.concat([decrypt.update(Buffer.from(envelope.ciphertext,"base64")),decrypt.final()]);if(bytes.length>MAX_DECOMPRESSED_BYTES)throw new Error("archive decompressed size limit exceeded");const archive=validateCommunityArchive(JSON.parse(bytes.toString("utf8")) as CommunityArchive,options.now);if(archive.schemaVersion!==envelope.schemaVersion||archive.archiveId!==envelope.archiveId||archive.sourceCommunityId!==envelope.sourceCommunityId||archive.destinationCommunityId!==envelope.destinationCommunityId||archive.createdAt!==envelope.createdAt||archive.expiresAt!==envelope.expiresAt)throw new Error("archive envelope payload metadata mismatch");return archive}finally{dek.fill(0)}
}

export type SemanticManifest={counts:Record<string,number>;relationshipGraph:string[];consentScopes:string[];tombstones:string[];auditHead:string|null;assetHashes:string[]};
export function canonicalManifest(archive:CommunityArchive):SemanticManifest {const counts:Record<string,number>={};for(const r of archive.records)counts[r.type]=(counts[r.type]??0)+1;return{counts:Object.fromEntries(Object.entries(counts).sort()),relationshipGraph:archive.records.filter(r=>r.parentId).map(r=>`${r.type}:${r.id}->${r.parentId}`).sort(),consentScopes:archive.records.map(r=>`${r.id}:${r.consentScope}`).sort(),tombstones:archive.records.filter(r=>r.tombstone).map(r=>r.id).sort(),auditHead:archive.audit.at(-1)?.hash??null,assetHashes:archive.assets.map(a=>`${a.id}:${a.sha256}`).sort()}}

type RequestState="requested"|"prepared"|"downloaded"|"expired"|"revoked";
type Request={id:string;communityId:string;actorId:string;state:RequestState;createdAt:string;expiresAt?:string;envelope?:CommunityArchiveEnvelope};
export class InMemoryArchiveRepository {readonly requests=new Map<string,Request>();readonly audit:{requestId:string;action:string;actorId:string;at:string}[]=[];readonly staged=new Map<string,CommunityArchive>();readonly active=new Map<string,{archiveId:string;manifest:SemanticManifest}>();failBeforePointer=false}
export class ArchiveCoordinator {
  private readonly repo:InMemoryArchiveRepository;
  private readonly limits:{maxActivePerCommunity:number;maxArchiveBytes:number;downloadTtlMs:number};
  private readonly authorizer:DownloadAuthorizationPort;
  constructor(repo:InMemoryArchiveRepository,limits:{maxActivePerCommunity:number;maxArchiveBytes:number;downloadTtlMs:number}={maxActivePerCommunity:2,maxArchiveBytes:32*1024*1024,downloadTtlMs:5*60_000},authorizer:DownloadAuthorizationPort=new MemoryDownloadAuthorizer()){this.repo=repo;this.limits=limits;this.authorizer=authorizer}
  request(input:{communityId:string;actorId:string;capability:string;now:Date}){if(input.capability!=="archive:export")throw new Error("archive request denied");const active=[...this.repo.requests.values()].filter(r=>r.communityId===input.communityId&&(r.state==="requested"||r.state==="prepared"));if(active.length>=this.limits.maxActivePerCommunity)throw new Error("archive quota exceeded");const id=`archive_request_${randomBytes(12).toString("hex")}`,request:Request={id,communityId:input.communityId,actorId:input.actorId,state:"requested",createdAt:input.now.toISOString()};this.repo.requests.set(id,request);this.audit(request,"requested",input.actorId,input.now);return structuredClone(request)}
  prepare(id:string,envelope:CommunityArchiveEnvelope,now:Date){const request=this.required(id);if(request.state!=="requested")throw new Error("archive is not requested");if(envelope.envelopeVersion!==1||envelope.profile!==COMMUNITY_ARCHIVE_PROFILE||envelope.schemaVersion!==SUPPORTED_SCHEMA)throw new Error("unsupported archive envelope");if(envelope.sourceCommunityId!==request.communityId)throw new Error("archive source community mismatch");const createdAt=Date.parse(envelope.createdAt),expiresAt=Date.parse(envelope.expiresAt);if(!Number.isFinite(createdAt)||!Number.isFinite(expiresAt)||createdAt>now.getTime()||expiresAt<=now.getTime()||expiresAt<=createdAt||expiresAt-createdAt>MAX_ARCHIVE_LIFETIME_MS)throw new Error("archive lifecycle metadata invalid");if(!envelope.archiveId||!envelope.destinationCommunityId||!envelope.recipientKeyId)throw new Error("archive identity metadata invalid");if(Buffer.byteLength(canonicalJson(envelope))>this.limits.maxArchiveBytes)throw new Error("archive size quota exceeded");request.state="prepared";request.envelope=envelope;request.expiresAt=envelope.expiresAt;this.audit(request,"prepared",request.actorId,now);return structuredClone(request)}
  authorizeDownload(id:string,actorId:string,now:Date){const request=this.required(id);if(request.state!=="prepared"||request.actorId!==actorId)throw new Error("archive download denied");const expiresAt=Math.min(Date.parse(request.expiresAt!),now.getTime()+this.limits.downloadTtlMs),body={requestId:id,actorId,expiresAt};return{...body,signature:this.authorizer.sign(canonicalJson(body))} }
  download(auth:{requestId:string;actorId:string;expiresAt:number;signature:string},now:Date){const body={requestId:auth.requestId,actorId:auth.actorId,expiresAt:auth.expiresAt};if(!this.authorizer.verify(canonicalJson(body),auth.signature)||now.getTime()>=auth.expiresAt)throw new Error("download authorization expired or invalid");const request=this.required(auth.requestId);if(request.state==="revoked")throw new Error("archive revoked");if(request.state!=="prepared")throw new Error("archive unavailable");request.state="downloaded";this.audit(request,"downloaded",auth.actorId,now);return structuredClone(request)}
  revoke(id:string,actorId:string,now:Date){const request=this.required(id);if(request.actorId!==actorId)throw new Error("archive revoke denied");request.state="revoked";request.envelope=undefined;this.audit(request,"revoked",actorId,now)}
  expire(now:Date){for(const request of this.repo.requests.values())if(request.expiresAt&&Date.parse(request.expiresAt)<=now.getTime()&&request.state!=="revoked"){request.state="expired";request.envelope=undefined;this.audit(request,"expired","system",now)}}
  dryRunImport(archive:CommunityArchive,options:{destinationExists:boolean;mergePolicy?:"replace"|"keep-existing"}){const conflicts:string[]=[];if(options.destinationExists&&!options.mergePolicy)conflicts.push("destination exists; explicit merge policy required");return{allowed:conflicts.length===0,conflicts,manifest:canonicalManifest(archive)}}
  stageImport(archive:CommunityArchive){if(this.repo.staged.has(archive.archiveId))return;this.repo.staged.set(archive.archiveId,structuredClone(archive))}
  commitImport(archiveId:string){const archive=this.repo.staged.get(archiveId);if(!archive)throw new Error("archive not staged");if(this.repo.failBeforePointer)throw new Error("import interrupted before commit pointer");this.repo.active.set(archive.destinationCommunityId,{archiveId,manifest:canonicalManifest(archive)});this.repo.staged.delete(archiveId)}
  cleanupImport(archiveId:string){return this.repo.staged.delete(archiveId)}
  private required(id:string){const value=this.repo.requests.get(id);if(!value)throw new Error("archive request not found");return value}
  private audit(request:Request,action:string,actorId:string,now:Date){this.repo.audit.push({requestId:request.id,action,actorId,at:now.toISOString()})}
}
