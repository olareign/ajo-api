import { HttpStatus, Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";
import { namesMatch } from "../kyc/names.js";
import { bankName } from "./banks.js";
import { PaymentContext } from "./payment-context.js";
import { coded } from "./payment-intents.js";
import { ProviderRejected, ProviderUnavailable } from "./providers/provider.port.js";

export type PayoutAccount = Readonly<{
  bankCode: string;
  bankName: string;
  last4: string;
  accountName: string;
}>;

type Row = {
  bank_code: string;
  bank_name: string;
  last4: string;
  account_name: string;
  recipient_code: string;
  provider: string;
};

/**
 * Where a person's withdrawals go. The bank must say the account is in the person's own name before
 * it can be used, and only the bank's recipient code is kept, never the full account number.
 */
@Injectable()
export class PayoutAccounts {
  constructor(
    private readonly db: DataSource,
    private readonly context: PaymentContext,
  ) {}

  async get(userId: string): Promise<PayoutAccount | null> {
    const row = await this.row(userId);
    return row
      ? {
          bankCode: row.bank_code,
          bankName: row.bank_name,
          last4: row.last4,
          accountName: row.account_name,
        }
      : null;
  }

  async row(userId: string): Promise<Row | undefined> {
    const [row] = await this.db.query<Row[]>(
      `SELECT bank_code, bank_name, last4, account_name, recipient_code, provider
         FROM payout_accounts WHERE user_id = $1`,
      [userId],
    );
    return row;
  }

  async set(
    userId: string,
    input: { bankCode: string; accountNumber: string },
  ): Promise<PayoutAccount> {
    const person = await this.context.person(userId);
    const provider = this.context.providerFor(person.country);
    if (!provider.supports.payout) {
      throw coded(
        HttpStatus.SERVICE_UNAVAILABLE,
        "Withdrawals aren't available in your country yet.",
        "payouts_not_available",
      );
    }
    try {
      const resolved = await provider.resolveAccount(input);
      if (!namesMatch(resolved.accountName, person.name)) {
        throw coded(
          HttpStatus.UNPROCESSABLE_ENTITY,
          `That account is in the name ${resolved.accountName}, which doesn't match your ID. Use an account in your own name.`,
          "name_mismatch",
        );
      }
      const recipient = await provider.createRecipient({
        name: resolved.accountName,
        bankCode: input.bankCode,
        accountNumber: input.accountNumber,
      });
      const name = bankName(input.bankCode);
      await this.db.transaction((tx) =>
        sql(
          tx,
          `INSERT INTO payout_accounts (user_id, provider, bank_code, bank_name, last4, account_name, recipient_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id) DO UPDATE SET provider = excluded.provider, bank_code = excluded.bank_code,
             bank_name = excluded.bank_name, last4 = excluded.last4, account_name = excluded.account_name,
             recipient_code = excluded.recipient_code, updated_at = now()`,
          [
            userId,
            provider.name,
            input.bankCode,
            name,
            input.accountNumber.slice(-4),
            resolved.accountName,
            recipient.recipientCode,
          ],
        ),
      );
      return {
        bankCode: input.bankCode,
        bankName: name,
        last4: input.accountNumber.slice(-4),
        accountName: resolved.accountName,
      };
    } catch (error) {
      if (error instanceof ProviderRejected) {
        throw coded(
          HttpStatus.UNPROCESSABLE_ENTITY,
          "We couldn't find that account. Check the bank and the number.",
          "account_not_found",
        );
      }
      if (error instanceof ProviderUnavailable) {
        throw coded(
          HttpStatus.SERVICE_UNAVAILABLE,
          "The payment partner could not be reached.",
          "payments_unavailable",
        );
      }
      throw error;
    }
  }
}
