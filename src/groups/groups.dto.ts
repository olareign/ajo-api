import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
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

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
const CODE = /^[A-Za-z0-9]{8}$/;

export class GroupDto {
  @ApiProperty({ example: "Cousins" }) @Transform(trim) @IsString() @Length(1, 60) name!: string;

  @ApiProperty({ required: false, example: "Lekki book club" })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  community?: string;

  @ApiProperty({ description: "Whole minor units each person pays each round" })
  @Matches(/^[1-9]\d{0,14}$/)
  contribution!: string;

  @ApiProperty({ enum: ["weekly", "biweekly", "monthly"] })
  @IsIn(["weekly", "biweekly", "monthly"])
  frequency!: "weekly" | "biweekly" | "monthly";

  @ApiProperty({ description: "How many people, which is also how many rounds", example: 6 })
  @IsInt()
  @Min(3)
  @Max(30)
  size!: number;

  @ApiProperty({ example: "2026-11-15", description: "The day the first round is collected" })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startDate!: string;

  @ApiProperty({ enum: ["random", "pick", "join_order"] })
  @IsIn(["random", "pick", "join_order"])
  orderMethod!: "random" | "pick" | "join_order";

  @ApiProperty({ enum: ["private", "public"] })
  @IsIn(["private", "public"])
  visibility!: "private" | "public";
}

export class JoinDto {
  @ApiProperty({ example: "K7M2QH9R", description: "The circle's invite code" })
  @IsString()
  @Matches(CODE)
  code!: string;
}

export class PickDto {
  @ApiProperty({ example: 3 }) @IsInt() @Min(1) @Max(30) spot!: number;
}

export class UsernameBody {
  @ApiProperty({ example: "ada_ola" })
  @Transform(trim)
  @Matches(/^@?[A-Za-z][A-Za-z0-9_]{2,19}$/)
  username!: string;
}

export class AnswerDto {
  @ApiProperty() @IsBoolean() accept!: boolean;
}

export class CreatorResponse {
  @ApiProperty({ nullable: true }) username!: string | null;
  @ApiProperty() displayName!: string;
}

export class GroupSummaryResponse {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) community!: string | null;
  @ApiProperty({ enum: ["open", "picking", "running", "completed", "cancelled"] }) status!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ description: "Each person's contribution, whole minor units" })
  contribution!: string;
  @ApiProperty({ enum: ["weekly", "biweekly", "monthly"] }) frequency!: string;
  @ApiProperty() size!: number;
  @ApiProperty() memberCount!: number;
  @ApiProperty({ example: "2026-11-15" }) startDate!: string;
  @ApiProperty({ enum: ["random", "pick", "join_order"] }) orderMethod!: string;
  @ApiProperty({ enum: ["private", "public"] }) visibility!: string;
  @ApiProperty({ description: "What each turn pays out before any fee, whole minor units" })
  pot!: string;
  @ApiProperty({ type: CreatorResponse }) creator!: CreatorResponse;
  @ApiProperty() isMember!: boolean;
  @ApiProperty() isCreator!: boolean;
  @ApiProperty({ nullable: true }) mySpot!: number | null;
  @ApiProperty({ description: "Friends of yours who are in it" }) friendsIn!: number;
  @ApiProperty({ nullable: true, description: "Only shown to members" }) inviteCode!: string | null;
  @ApiProperty({
    type: Object,
    description: "The deposits, fee and grace period this circle was made with",
  })
  rules!: unknown;
}

export class DiscoverResponse extends GroupSummaryResponse {
  @ApiProperty({ description: "How well it fits you: friends in it count most" }) score!: number;
}

export class GroupsResponse {
  @ApiProperty({ type: [GroupSummaryResponse] }) groups!: GroupSummaryResponse[];
}

export class DiscoverListResponse {
  @ApiProperty({ type: [DiscoverResponse] }) groups!: DiscoverResponse[];
}

export class GroupPreviewResponse {
  @ApiProperty({ type: [String] }) dates!: string[];
  @ApiProperty({ type: MoneyResponse }) pot!: MoneyResponse;
  @ApiProperty({ type: MoneyResponse, description: "The fee taken from each payout" })
  fee!: MoneyResponse;
  @ApiProperty({
    type: MoneyResponse,
    description: "What an untrusted member locks until the circle ends",
  })
  deposit!: MoneyResponse;
  @ApiProperty({
    type: MoneyResponse,
    description: "What an untrusted member locks to take an early turn",
  })
  earlyDeposit!: MoneyResponse;
  @ApiProperty() earlySpots!: number;
  @ApiProperty() graceDays!: number;
}

export class GroupDetailResponse extends GroupSummaryResponse {
  @ApiProperty({
    type: [Object],
    description: "Members, with their turn, trust level and this round's payment (members only)",
  })
  members!: unknown[];
  @ApiProperty({
    type: [Object],
    description: "Every round: its day, who takes it, how it is going, and who has paid",
  })
  rounds!: unknown[];
  @ApiProperty({
    type: [Object],
    description: "Each draw, with its seed and result, so anyone can check it",
  })
  draws!: unknown[];
  @ApiProperty({ type: MoneyResponse, nullable: true, description: "What you have locked here" })
  myDeposit!: MoneyResponse | null;
  @ApiProperty({ nullable: true }) pickDeadline!: string | null;
  @ApiProperty({ type: Object, nullable: true }) nextDue!: unknown;
  @ApiProperty() graceDays!: number;
}

export class SwapResponse {
  @ApiProperty() id!: string;
  @ApiProperty() fromUsername!: string;
  @ApiProperty() fromName!: string;
  @ApiProperty() toUsername!: string;
  @ApiProperty() toName!: string;
  @ApiProperty({ description: "True when it was asked of you" }) incoming!: boolean;
}
