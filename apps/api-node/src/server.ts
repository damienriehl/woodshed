import { serve } from "@hono/node-server";
import { createApi } from "./app.ts";
import { ChoiceService } from "../../../packages/application/src/choice-service.ts";

const service = new ChoiceService(process.env.WOODSHED_DB ?? "woodshed.sqlite");
service.migrate();
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: createApi(service,{origin:process.env.WOODSHED_ORIGIN ?? `http://127.0.0.1:${port}`}).fetch, port });
