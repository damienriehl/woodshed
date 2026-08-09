export type ChoiceRequest = { method:string; path:string; headers:Readonly<Record<string,string>>; body?:unknown };
export type ChoiceResponse = { status:number; headers:Readonly<Record<string,string>>; body?:unknown };
export interface ChoiceHttpPort { handle(request:ChoiceRequest):Promise<ChoiceResponse>; }
