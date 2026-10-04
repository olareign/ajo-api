import { ApiProperty } from "@nestjs/swagger";
import { IsOptional, Matches } from "class-validator";

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
