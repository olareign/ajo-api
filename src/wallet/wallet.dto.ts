import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, Matches, Max, Min } from "class-validator";

export class MoneyResponse {
  @ApiProperty({
    description: "Whole number in the currency's smallest unit (kobo, pence, cents)",
    example: "250000",
  })
  amount!: string;

  @ApiProperty({ example: "NGN" })
  currency!: string;
}

export class WalletResponse {
  @ApiProperty({ example: "NGN" }) currency!: string;
  @ApiProperty({ type: MoneyResponse }) available!: MoneyResponse;
  @ApiProperty({ type: MoneyResponse }) locked!: MoneyResponse;
  @ApiProperty({ type: MoneyResponse }) savings!: MoneyResponse;
}

export class WalletsResponse {
  @ApiProperty({ type: [WalletResponse] }) wallets!: WalletResponse[];
}

export class TransactionItem {
  @ApiProperty({ description: "Stable id of this row, also the paging cursor" }) id!: string;
  @ApiProperty() transactionId!: string;
  @ApiProperty({ example: "funding" }) type!: string;
  @ApiProperty({ enum: ["available", "locked", "savings"] }) account!: string;
  @ApiProperty({ enum: ["in", "out"] }) direction!: "in" | "out";
  @ApiProperty({ type: MoneyResponse }) amount!: MoneyResponse;
  @ApiProperty() currency!: string;
  @ApiProperty() createdAt!: string;
}

export class TransactionsResponse {
  @ApiProperty({ type: [TransactionItem] }) items!: TransactionItem[];
  @ApiProperty({
    nullable: true,
    description: "Pass as `before` for the next page; null at the end",
  })
  next!: string | null;
}

export class TransactionsQuery {
  @ApiProperty({ required: false, minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Matches(/^\d{1,18}$/)
  before?: string;
}
