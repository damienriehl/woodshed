#!/usr/bin/env node
const command=process.argv[2];
const supported=["health","archive:export","archive:import:dry-run","backup:verify","restore:verify","upgrade:dry-run"];
if(!command||!supported.includes(command)){process.stderr.write(`Usage: woodshed-operator <${supported.join("|")}>\n`);process.exitCode=2}
else process.stdout.write(JSON.stringify({command,status:"adapter-required"})+"\n");
