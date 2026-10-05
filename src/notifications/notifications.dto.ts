import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsOptional, Matches } from "class-validator";

export class NotificationResponse {
  @ApiProperty() id!: string;
  @ApiProperty() kind!: string;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiProperty({ nullable: true, description: "An in-app path to open" }) link!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true }) readAt!: string | null;
}

export class NotificationsResponse {
  @ApiProperty({ type: [NotificationResponse] }) items!: NotificationResponse[];
  @ApiProperty({ nullable: true, description: "Pass as `before` for the next page" })
  next!: string | null;
  @ApiProperty({ description: "How many are unread, across every page" }) unread!: number;
}

export class NotificationsQuery {
  @ApiProperty({ required: false }) @IsOptional() @Matches(/^\d{1,3}$/) limit?: string;
  @ApiProperty({ required: false }) @IsOptional() @Matches(/^\d{1,20}$/) before?: string;
}

export class NotificationSettingsResponse {
  @ApiProperty({ description: "Reminders before a debit or a circle payment" }) reminders!: boolean;
  @ApiProperty({ description: "News about saving plans (not money moving)" }) savings!: boolean;
  @ApiProperty({ description: "News about circles (not money moving)" }) circles!: boolean;
  @ApiProperty({ description: "Friend requests and answers" }) friends!: boolean;
}

/** Only the categories named change. Money and account emails can't be turned off. */
export class NotificationSettingsDto {
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() reminders?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() savings?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() circles?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() friends?: boolean;
}
