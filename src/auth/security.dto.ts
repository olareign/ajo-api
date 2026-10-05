import { ApiProperty } from "@nestjs/swagger";
import { IsOptional, IsString, IsUUID, Length, Matches } from "class-validator";

const SIX = /^\d{6}$/;

export class ChangePasswordDto {
  @ApiProperty() @IsString() @Length(1, 1024) currentPassword!: string;
  @ApiProperty({ description: "Checked as at sign-up" })
  @IsString()
  @Length(1, 1024)
  newPassword!: string;
  @ApiProperty({ required: false, description: "6-digit authenticator code, when it is on" })
  @IsOptional()
  @IsString()
  @Matches(SIX)
  code?: string;
}

export class ChangePinDto {
  @ApiProperty({ description: "Six digits" }) @IsString() @Matches(SIX) currentPin!: string;
  @ApiProperty({ description: "Six digits" }) @IsString() @Matches(SIX) newPin!: string;
}

export class ResetPinDto {
  @ApiProperty() @IsString() @Length(1, 1024) password!: string;
  @ApiProperty({ description: "6-digit authenticator code" })
  @IsString()
  @Matches(SIX)
  code!: string;
  @ApiProperty({ description: "Six digits" }) @IsString() @Matches(SIX) newPin!: string;
}

export class StepUpDto {
  @ApiProperty() @IsString() @Length(1, 1024) password!: string;
  @ApiProperty({ description: "6-digit authenticator code" })
  @IsString()
  @Matches(SIX)
  code!: string;
}

export class IdParam {
  @IsUUID() id!: string;
}

export class SessionResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: "Chrome on Android" }) device!: string;
  @ApiProperty({ nullable: true, example: "102.89.x.x", description: "The first part only" })
  ip!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() lastSeenAt!: string;
  @ApiProperty({ description: "The device asking" }) current!: boolean;
}

export class TrustedDeviceResponse {
  @ApiProperty() id!: string;
  @ApiProperty() device!: string;
  @ApiProperty() lastUsedAt!: string;
  @ApiProperty() expiresAt!: string;
}

export class SecurityEventResponse {
  @ApiProperty({
    enum: [
      "signed_in",
      "new_device",
      "password_changed",
      "password_reset",
      "pin_changed",
      "pin_reset",
      "mfa_on",
      "mfa_off",
      "recovery_codes_renewed",
      "device_signed_out",
      "signed_out_everywhere",
      "device_forgotten",
    ],
  })
  kind!: string;
  @ApiProperty({ nullable: true }) device!: string | null;
  @ApiProperty({ nullable: true, description: "The first part only" }) ip!: string | null;
  @ApiProperty() at!: string;
}

export class RecoveryCodesOnlyResponse {
  @ApiProperty({ type: [String], description: "Shown once; the old set no longer works" })
  recoveryCodes!: string[];
}

export class CloseAccountDto {
  @ApiProperty() @IsString() @Length(1, 1024) password!: string;
  @ApiProperty({ required: false, description: "6-digit authenticator code, when it is on" })
  @IsOptional()
  @IsString()
  @Matches(SIX)
  code?: string;
}
