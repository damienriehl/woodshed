#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { healthConfigFromEnvironment, probeOperatorHealth } from "./index.ts";

const supported=["health","archive:export","archive:import:dry-run","backup:verify","restore:verify","upgrade:dry-run"];

export async function main(argv=process.argv.slice(2)){
  const command=argv[0];
  if(!command||!supported.includes(command)){process.stderr.write(`Usage: woodshed-operator <${supported.join("|")}>\n`);return 2}
  if(command==="health"){
    const result=await probeOperatorHealth(healthConfigFromEnvironment());
    process.stdout.write(JSON.stringify(result)+"\n");
    return result.exitCode;
  }
  process.stdout.write(JSON.stringify({command,status:"adapter-required"})+"\n");
  return 1;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main();
