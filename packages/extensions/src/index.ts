export type Extension={id:string;permissions:readonly string[]};
export class ExtensionHost {
  readonly privateContentEnabled=false;
  async invoke(extension:Extension,capability:string,context:{rightsApproved?:boolean;privacyApproved?:boolean}){
    if(!extension.permissions.includes(capability))throw new Error("extension capability denied");
    if(capability.startsWith("content:")&&!context.rightsApproved)throw new Error("content rights approval required");
    if(capability.startsWith("private:")&&(!this.privateContentEnabled||!context.privacyApproved))throw new Error("private content disabled pending terms and privacy approval");
    return{extensionId:extension.id,capability,status:"accepted" as const};
  }
}
