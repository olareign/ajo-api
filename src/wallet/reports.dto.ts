import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, Matches, Max, Min } from "class-validator";

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export class StatementQuery {
  @ApiProperty({ example: "2026-09-01", description: "First day, in the account's own time zone" })
  @Matches(DAY)
  from!: string;

  @ApiProperty({ example: "2026-09-30", description: "Last day, included" })
  @Matches(DAY)
  to!: string;
}

export class StatementLine {
  @ApiProperty() id!: string;
  @ApiProperty({ description: "When it happened" }) at!: string;
  @ApiProperty({ example: "funding" }) type!: string;
  @ApiProperty({ enum: ["available", "locked", "savings"] }) account!: string;
  @ApiProperty({ enum: ["in", "out"] }) direction!: string;
  @ApiProperty({ description: "Minor units" }) amount!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ nullable: true }) reference!: string | null;
}

export class StatementBalance {
  @ApiProperty() currency!: string;
  @ApiProperty({ description: "Minor units, before the first day" }) opening!: string;
  @ApiProperty({ description: "Minor units, at the end of the last day" }) closing!: string;
  @ApiProperty() moneyIn!: string;
  @ApiProperty() moneyOut!: string;
}

export class StatementResponse {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ example: "Africa/Lagos" }) timeZone!: string;
  @ApiProperty({ type: [StatementBalance] }) balances!: StatementBalance[];
  @ApiProperty({ type: [StatementLine] }) lines!: StatementLine[];
  @ApiProperty({ description: "More lines than one statement holds; choose a shorter range" })
  truncated!: boolean;
}

export class InsightsQuery {
  @ApiProperty({ required: false, minimum: 1, maximum: 24, default: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  months?: number;
}

export class InsightMonth {
  @ApiProperty({ example: "2026-09" }) month!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ description: "Top-ups, circle payouts and returned withdrawals" })
  moneyIn!: string;
  @ApiProperty({ description: "Withdrawals, circle payments, late charges and deposit covers" })
  moneyOut!: string;
  @ApiProperty({ description: "Net change in saving plans (can be negative)" }) savedNet!: string;
  @ApiProperty() endAvailable!: string;
  @ApiProperty() endSavings!: string;
  @ApiProperty() endLocked!: string;
}

export class InsightsResponse {
  @ApiProperty() timeZone!: string;
  @ApiProperty({ type: [InsightMonth] }) months!: InsightMonth[];
}
