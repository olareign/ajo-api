import { ApiProperty } from "@nestjs/swagger";
import { IsIn, Matches } from "class-validator";

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
