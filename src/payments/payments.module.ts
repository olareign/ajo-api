import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { KycModule } from "../kyc/kyc.module.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { PaymentsController } from "./payments.controller.js";
import { PaymentsService } from "./payments.service.js";
import { PaymentEvents } from "./payment-events.service.js";
import { HTTP_FETCH, PaymentProviders } from "./providers/providers.service.js";
import { WebhookInbox } from "./webhook-inbox.service.js";
import { WebhooksController } from "./webhooks.controller.js";

@Module({
  imports: [LedgerModule, KycModule, AuthModule],
  controllers: [PaymentsController, WebhooksController],
  providers: [
    { provide: HTTP_FETCH, useValue: globalThis.fetch },
    PaymentProviders,
    PaymentEvents,
    WebhookInbox,
    PaymentsService,
  ],
  exports: [PaymentProviders, PaymentEvents, WebhookInbox, PaymentsService],
})
export class PaymentsModule {}
