export type ProviderPayload = Readonly<{ category:string; recipientRef:string }>;
export interface ProviderPort {
  send(deliveryId:string,payload:ProviderPayload):Promise<void>;
  revoke(connectionId:string):Promise<void>;
}
export class ProviderRateLimitError extends Error { constructor(){super("rate-limited");} }
export class MemoryProviderAdapter implements ProviderPort {
  readonly sent:{deliveryId:string;payload:ProviderPayload}[]=[];
  readonly revoked:string[]=[];
  private failFirst:boolean;
  constructor(options:{failFirstWithRateLimit?:boolean}={}){this.failFirst=options.failFirstWithRateLimit??false;}
  async send(deliveryId:string,payload:ProviderPayload){if(this.failFirst){this.failFirst=false;throw new ProviderRateLimitError();}this.sent.push({deliveryId,payload});}
  async revoke(connectionId:string){this.revoked.push(connectionId);}
}
