import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module.js";
import { configureApp } from "./app/configure-app.js";
import type { Env } from "./config/env.js";
import { ENV } from "./config/env.module.js";
import { setupApiDocs } from "./openapi/api-docs.js";

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  bodyParser: false,
  bufferLogs: true,
});
app.useLogger(app.get(Logger));

const env = app.get<Env>(ENV);
configureApp(app, env);
if (env.API_DOCS_ENABLED) {
  setupApiDocs(app);
}

await app.listen(env.PORT, "0.0.0.0");
