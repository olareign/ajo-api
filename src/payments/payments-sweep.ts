import { Injectable, type OnModuleInit } from "@nestjs/common";
import { Scheduler } from "../scheduler/scheduler.service.js";
import { PaymentsService } from "./payments.service.js";
import { WebhookInbox } from "./webhook-inbox.service.js";

/** The safety net under the webhooks: retry partner messages held back, and settle payments that sat pending. */
@Injectable()
export class PaymentsSweep implements OnModuleInit {
  constructor(
    private readonly scheduler: Scheduler,
    private readonly inbox: WebhookInbox,
    private readonly payments: PaymentsService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: "payments",
      run: async () => {
        await this.inbox.drain();
        await this.payments.reconcileStale();
      },
    });
  }
}
