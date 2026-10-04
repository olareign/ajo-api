import { Module } from "@nestjs/common";
import { LedgerModule } from "../ledger/ledger.module.js";
import { PaymentEvents } from "./payment-events.service.js";
import { HTTP_FETCH, PaymentProviders } from "./providers/providers.service.js";
import { WebhookInbox } from "./webhook-inbox.service.js";
import { WebhooksController } from "./webhooks.controller.js";

@Module({
  imports: [LedgerModule],
  controllers: [WebhooksController],
  providers: [
    { provide: HTTP_FETCH, useValue: globalThis.fetch },
    PaymentProviders,
    PaymentEvents,
    WebhookInbox,
  ],
  exports: [PaymentProviders, PaymentEvents, WebhookInbox],
})
export class PaymentsModule {}
