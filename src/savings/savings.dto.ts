import { ApiProperty } from "@nestjs/swagger";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from "class-validator";
import { MoneyResponse } from "../payments/payments.dto.js";

const AMOUNT = /^[1-9]\d{0,14}$/;

export class PlanDto {
  @ApiProperty({ example: "Rent" }) @IsString() @Length(1, 60) name!: string;

  @ApiProperty({ description: "Whole minor units per debit, e.g. 500000 for ₦5,000" })
  @Matches(AMOUNT)
  amount!: string;

  @ApiProperty({ enum: ["daily", "weekly", "monthly"] })
  @IsIn(["daily", "weekly", "monthly"])
  frequency!: "daily" | "weekly" | "monthly";

  @ApiProperty({ description: "How many debits in all", example: 12 })
  @IsInt()
  @Min(2)
  @Max(366)
  totalDebits!: number;

  @ApiProperty({ example: "2026-11-01", description: "The day of the first debit" })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startDate!: string;

  @ApiProperty({
    required: false,
    description: "Collect any shortfall from the bank under auto-debit when the wallet is short",
  })
  @IsOptional()
  @IsBoolean()
  topupFromBank?: boolean;
}

export class TopUpDto {
  @ApiProperty({ description: "Whole minor units to add from the wallet now" })
  @Matches(AMOUNT)
  amount!: string;
}

export class EarlyWithdrawDto {
  @ApiProperty({ description: "The 6-digit transaction PIN" })
  @IsString()
  @Matches(/^\d{6}$/)
  pin!: string;
}

export class DebitResponse {
  @ApiProperty() seq!: number;
  @ApiProperty({ example: "2026-11-01" }) dueOn!: string;
  @ApiProperty({ enum: ["scheduled", "paid", "failed", "skipped"] }) status!: string;
}

export class HistoryResponse {
  @ApiProperty({
    description: "savings_debit, savings_topup, savings_maturity or savings_early_withdrawal",
  })
  type!: string;
  @ApiProperty({ enum: ["in", "out"], description: "Into the plan, or out of it" })
  direction!: string;
  @ApiProperty({ type: MoneyResponse }) amount!: MoneyResponse;
  @ApiProperty() createdAt!: string;
}

export class NextDebitResponse {
  @ApiProperty({ example: "2026-11-01" }) dueOn!: string;
  @ApiProperty({ type: MoneyResponse }) amount!: MoneyResponse;
}

export class PlanResponse {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ["active", "paused", "completed", "cancelled"] }) status!: string;
  @ApiProperty({ enum: ["daily", "weekly", "monthly"] }) frequency!: string;
  @ApiProperty({ type: MoneyResponse, description: "Each debit" }) amount!: MoneyResponse;
  @ApiProperty() totalDebits!: number;
  @ApiProperty({ example: "2026-11-01" }) startDate!: string;
  @ApiProperty({ example: "2027-01-24", description: "The day of the last scheduled debit" })
  endDate!: string;
  @ApiProperty({ type: MoneyResponse, description: "What is in the plan now, from the ledger" })
  saved!: MoneyResponse;
  @ApiProperty({ type: MoneyResponse, description: "Every debit added up: the goal" })
  target!: MoneyResponse;
  @ApiProperty() paidDebits!: number;
  @ApiProperty() failedDebits!: number;
  @ApiProperty({ type: NextDebitResponse, nullable: true }) nextDebit!: NextDebitResponse | null;
  @ApiProperty() topupFromBank!: boolean;
  @ApiProperty({ type: MoneyResponse, nullable: true, description: "What came back to the wallet" })
  payout!: MoneyResponse | null;
  @ApiProperty({ type: MoneyResponse, description: "What an early withdrawal cost" })
  penalty!: MoneyResponse;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true }) closedAt!: string | null;
}

export class PlanDetailResponse extends PlanResponse {
  @ApiProperty({
    description:
      "What ending the plan early costs, in hundredths of a percent of what was saved (0 = free)",
  })
  earlyWithdrawalPenaltyBps!: number;
  @ApiProperty({ type: [DebitResponse] }) schedule!: DebitResponse[];
  @ApiProperty({ type: [HistoryResponse], description: "Newest first, up to 50" })
  history!: HistoryResponse[];
}

export class PlansResponse {
  @ApiProperty({ type: [PlanResponse] }) plans!: PlanResponse[];
}

export class PreviewResponse {
  @ApiProperty({ type: [String], example: ["2026-11-01", "2026-11-08"] }) dates!: string[];
  @ApiProperty({ type: MoneyResponse }) total!: MoneyResponse;
  @ApiProperty({ example: "2027-01-24" }) endDate!: string;
}
