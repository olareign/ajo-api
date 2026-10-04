import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, Length, Matches } from "class-validator";
import { REPORT_REASONS, type ReportReason } from "./safety.service.js";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
const NAME = /^@?[A-Za-z][A-Za-z0-9_]{2,19}$/;

export class UsernameDto {
  @ApiProperty({ example: "ada_ola", description: "Their username, with or without the @" })
  @Transform(trim)
  @Matches(NAME)
  username!: string;
}

export class ReportDto extends UsernameDto {
  @ApiProperty({ enum: REPORT_REASONS }) @IsIn(REPORT_REASONS) reason!: ReportReason;

  @ApiProperty({ required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  details?: string;
}

export class SearchQuery {
  @ApiProperty({ description: "The start of a username, at least 3 letters" })
  @Transform(trim)
  @IsString()
  @Length(1, 30)
  q!: string;
}

export class PersonResponse {
  @ApiProperty() username!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({
    enum: ["none", "friend", "requested", "incoming"],
    description: "Your relationship to them",
  })
  relation!: string;
  @ApiProperty({ description: "Friends you have in common" }) mutualFriends!: number;
  @ApiProperty({ enum: [1, 2], description: "1 passport stamped; 2 with a national check too" })
  tier!: number;
}

export class SuggestionResponse extends PersonResponse {
  @ApiProperty({ enum: ["mutual", "invited_you", "you_invited"] }) reason!: string;
  @ApiProperty({ type: [String], description: "Up to two of the friends you have in common" })
  mutualNames!: string[];
}

export class FriendResponse {
  @ApiProperty() username!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() since!: string;
  @ApiProperty({ enum: [1, 2] }) tier!: number;
}

export class FriendsResponse {
  @ApiProperty({ type: [FriendResponse] }) friends!: FriendResponse[];
}

export class RequestResponse {
  @ApiProperty() username!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() sentAt!: string;
  @ApiProperty({ enum: [1, 2] }) tier!: number;
}

export class RequestsResponse {
  @ApiProperty({ type: [RequestResponse] }) incoming!: RequestResponse[];
  @ApiProperty({ type: [RequestResponse] }) outgoing!: RequestResponse[];
}

export class RelationResponse {
  @ApiProperty({ enum: ["none", "friend", "requested", "incoming"] }) relation!: string;
}

export class BlockedResponse {
  @ApiProperty() username!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() blockedAt!: string;
}

export class InviteResponse {
  @ApiProperty({ example: "K7M2QH9R" }) code!: string;
  @ApiProperty({ example: "https://app.example/join/K7M2QH9R" }) link!: string;
}

export class InviterResponse {
  @ApiProperty({ description: "First name only" }) name!: string;
  @ApiProperty({ nullable: true }) username!: string | null;
}
