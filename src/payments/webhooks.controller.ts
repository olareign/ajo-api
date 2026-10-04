import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import type { RequestWithRawBody } from "../app/configure-app.js";
import { Public } from "../auth/public.decorator.js";
import { InvalidWebhookSignature, type ProviderName } from "./providers/provider.port.js";
import { PaymentProviders } from "./providers/providers.service.js";
import { WebhookInbox } from "./webhook-inbox.service.js";

/** Where each partner puts its signature. */
const SIGNATURE_HEADER: Readonly<Record<ProviderName, string>> = {
  paystack: "x-paystack-signature",
  gocardless: "webhook-signature",
  fake: "x-fake-signature",
};

const isProvider = (value: string): value is ProviderName => value in SIGNATURE_HEADER;

/**
 * Where partners tell us what happened to money. Nothing here uses a session: the signature, checked
 * over the exact bytes received, is the proof. A forged request is refused and stores nothing; a real
 * one is stored and answered 200 straight away, whether or not acting on it succeeded, because it is
 * safe in the inbox and will be retried from there.
 */
@ApiTags("webhooks")
@Controller("webhooks")
@Public()
@SkipThrottle()
export class WebhooksController {
  constructor(
    private readonly providers: PaymentProviders,
    private readonly inbox: WebhookInbox,
  ) {}

  @Post(":provider")
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: "Stored. The body says how many events it held." })
  async receive(
    @Param("provider") name: string,
    @Req() req: RequestWithRawBody,
    @Headers() headers: Record<string, string | undefined>,
  ): Promise<{ received: number }> {
    if (!isProvider(name)) throw new NotFoundException();
    const provider = this.providers.byName(name);
    if (!provider) throw new NotFoundException();
    if (!req.rawBody) throw new BadRequestException("Send the event as JSON.");
    try {
      return {
        received: await this.inbox.receive(provider, req.rawBody, headers[SIGNATURE_HEADER[name]]),
      };
    } catch (error) {
      if (error instanceof InvalidWebhookSignature) throw new UnauthorizedException();
      throw error;
    }
  }
}
