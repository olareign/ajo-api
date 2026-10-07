import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsString, Length, Matches, ValidateNested } from "class-validator";

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export class PushKeysDto {
  @ApiProperty() @IsString() @Length(1, 200) @Matches(BASE64URL) p256dh!: string;
  @ApiProperty() @IsString() @Length(1, 100) @Matches(BASE64URL) auth!: string;
}

/** The browser's own description of where to send pushes (what `PushSubscription.toJSON()` gives). */
export class SubscribeDto {
  @ApiProperty({ example: "https://fcm.googleapis.com/fcm/send/…" })
  @IsString()
  @Length(10, 2048)
  endpoint!: string;

  @ApiProperty({ type: PushKeysDto })
  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;
}

export class UnsubscribeDto {
  @ApiProperty() @IsString() @Length(10, 2048) endpoint!: string;
}

export class PushStatusResponse {
  @ApiProperty({ description: "False until push is switched on" }) enabled!: boolean;
  @ApiProperty({ nullable: true, description: "Needed by the browser to subscribe" })
  publicKey!: string | null;
  @ApiProperty({ description: "How many of this person's browsers are subscribed" })
  devices!: number;
}
