export type ProviderConnection={id:string;scopes:readonly string[];derivedData:readonly string[]};
export class ProviderRegistry {
  private readonly values=new Map<string,ProviderConnection>();
  connect(connection:ProviderConnection){if(connection.scopes.length===0)throw new Error("provider scopes required");this.values.set(connection.id,{...connection,scopes:[...connection.scopes],derivedData:[...connection.derivedData]})}
  get(id:string){return this.values.get(id)}
  async disconnect(id:string){const connection=this.values.get(id);if(!connection)return{revoked:false,deletedDerivedData:0};this.values.delete(id);return{revoked:true,deletedDerivedData:connection.derivedData.length}}
}
