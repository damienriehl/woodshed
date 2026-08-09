import type { ChoiceHttpPort } from "../../../packages/application/src/choice-port.ts";

export type WorkerBindings = { CHOICE_APPLICATION: ChoiceHttpPort };
const BODYLESS_METHODS=new Set(["GET","HEAD"]);

export default {
  async fetch(request:Request,env:WorkerBindings):Promise<Response>{
    const url=new URL(request.url);
    const headers=Object.fromEntries(request.headers.entries());
    const hasBody=!BODYLESS_METHODS.has(request.method);
    const body=hasBody?await request.json().catch(()=>undefined):undefined;
    const result=await env.CHOICE_APPLICATION.handle({method:request.method,path:`${url.pathname}${url.search}`,headers,body});
    const responseHeaders:Record<string,string>={"referrer-policy":"no-referrer","cache-control":"private, no-store",...result.headers};
    if(result.body!==undefined)responseHeaders["content-type"]="application/json";
    return new Response(result.body===undefined?null:JSON.stringify(result.body),{status:result.status,headers:responseHeaders});
  },
};
