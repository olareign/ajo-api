import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsString, Matches } from "class-validator";

/** Whole minor units (kobo, pence), no sign, no decimals, no leading zero, at most 15 digits. */
export const AMOUNT = /^[1-9]\d{0,14}$/;

export class MoneyResponse {
  @ApiProperty({ description: "Whole minor units (kobo, pence) as a string" }) amount!: string;
  @ApiProperty({ enum: ["NGN", "GBP"] }) currency!: string;
}

export class ActionResponse {
  @ApiProperty({ enum: ["redirect"] }) type!: string;
  @ApiProperty() url!: string;
}

export class PaymentResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ["funding", "withdrawal"] }) kind!: string;
  @ApiProperty({ enum: ["created", "pending", "succeeded", "failed", "reversed"] }) status!: string;
  @ApiProperty({ enum: ["card", "transfer", "ussd", "direct_debit", "bank_account"] })
  method!: string;
  @ApiProperty({ type: MoneyResponse }) amount!: MoneyResponse;
  @ApiProperty({
    type: ActionResponse,
    nullable: true,
    description: "Where the person goes next to pay",
  })
  action!: ActionResponse | null;
  @ApiProperty({ nullable: true }) failureReason!: string | null;
  @ApiProperty() createdAt!: string;
}

export class FundDto {
  @ApiProperty({ description: "Whole minor units as a string, e.g. 500000 for ₦5,000" })
  @Matches(AMOUNT)
  amount!: string;

  @ApiProperty({ enum: ["card", "transfer", "ussd", "direct_debit"] })
  @IsIn(["card", "transfer", "ussd", "direct_debit"])
  method!: "card" | "transfer" | "ussd" | "direct_debit";
}

export class WithdrawDto {
  @ApiProperty({ description: "Whole minor units as a string, e.g. 500000 for ₦5,000" })
  @Matches(AMOUNT)
  amount!: string;

  @ApiProperty({ description: "The 6-digit transaction PIN" })
  @IsString()
  @Matches(/^\d{6}$/)
  pin!: string;
}

export class PayoutAccountDto {
  @ApiProperty({ example: "058", description: "The bank's code" })
  @Matches(/^[0-9]{3,6}$/)
  bankCode!: string;

  @ApiProperty({ example: "0123456789" })
  @Matches(/^[0-9]{10}$/)
  accountNumber!: string;
}

export class PayoutAccountResponse {
  @ApiProperty() bankCode!: string;
  @ApiProperty() bankName!: string;
  @ApiProperty({ description: "The last four digits, for recognising it" }) last4!: string;
  @ApiProperty({ description: "The name the bank holds the account under" }) accountName!: string;
}

export class BankResponse {
  @ApiProperty({ example: "058" }) code!: string;
  @ApiProperty({ example: "GTBank" }) name!: string;
}

export class BanksResponse {
  @ApiProperty({ type: [BankResponse] }) banks!: BankResponse[];
}

export class MandateResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ["pending", "active", "cancelled", "failed"] }) status!: string;
  @ApiProperty({
    type: ActionResponse,
    nullable: true,
    description: "Where the person goes to give their permission",
  })
  action!: ActionResponse | null;
  @ApiProperty() createdAt!: string;
}
