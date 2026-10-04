import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { KycModule } from "../kyc/kyc.module.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { PaymentsController } from "./payments.controller.js";
import { ActiveCommitments } from "./commitments.js";
import { Mandates } from "./mandates.service.js";
import { PaymentContext } from "./payment-context.js";
import { PaymentsService } from "./payments.service.js";
import { PayoutAccounts } from "./payout-accounts.service.js";
import { Withdrawals } from "./withdrawals.service.js";
import { PaymentsSweep } from "./payments-sweep.js";
import { PaymentEvents } from "./payment-events.service.js";
import { HTTP_FETCH, PaymentProviders } from "./providers/providers.service.js";
import { WebhookInbox } from "./webhook-inbox.service.js";
import { WebhooksController } from "./webhooks.controller.js";

@Module({
  imports: [LedgerModule, KycModule, AuthModule, IdentityModule],
  controllers: [PaymentsController, WebhooksController],
  providers: [
    { provide: HTTP_FETCH, useValue: globalThis.fetch },
    PaymentProviders,
    PaymentEvents,
    WebhookInbox,
    PaymentContext,
    PaymentsService,
    PaymentsSweep,
    PayoutAccounts,
    Withdrawals,
    Mandates,
    ActiveCommitments,
  ],
  exports: [PaymentProviders, PaymentEvents, WebhookInbox, PaymentsService],
})
export class PaymentsModule {}
