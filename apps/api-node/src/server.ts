import { serve } from "@hono/node-server";
import { createApi } from "./app.ts";
import { ChoiceService } from "../../../packages/application/src/choice-service.ts";
import { CoordinationService } from "../../../packages/application/src/coordination-service.ts";
import { SqliteCoordinationRepository } from "../../../packages/storage-sqlite/src/coordination-repository.ts";

const service = new ChoiceService(process.env.WOODSHED_DB ?? "woodshed.sqlite");
service.migrate();
const coordination = new CoordinationService({repository:new SqliteCoordinationRepository(service.database)});
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: createApi(service,{origin:process.env.WOODSHED_ORIGIN ?? `http://127.0.0.1:${port}`,coordination}).fetch, port });
