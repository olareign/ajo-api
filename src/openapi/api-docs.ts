import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle("Àjọ API")
    .setDescription(
      "Business API for the Àjọ web and mobile apps. Amounts are integer minor units sent as strings.",
    )
    .setVersion("1")
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, config);
}

/** Interactive docs for local development only; never enabled in production (see env). */
export function setupApiDocs(app: INestApplication): void {
  SwaggerModule.setup("api/docs", app, buildOpenApiDocument(app));
}
