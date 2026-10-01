import "reflect-metadata";
import { writeFileSync } from "node:fs";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { configureApp } from "./app/configure-app.js";
import { loadEnv } from "./config/env.js";
import { buildOpenApiDocument } from "./openapi/api-docs.js";

/**
 * Writes the OpenAPI spec that the web and mobile clients are generated from. Runs in
 * preview mode (no providers instantiated), so no database or Redis is contacted.
 */
const output = process.argv[2] ?? "openapi.json";
const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  bodyParser: false,
  logger: false,
  preview: true,
});
configureApp(app, loadEnv(process.env));
writeFileSync(output, `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`);
await app.close();
