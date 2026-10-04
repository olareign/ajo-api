import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from "class-validator";

export class LoginDto {
  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 1024)
  password!: string;

  @ApiProperty({
    required: false,
    description:
      "The secret of a device that was asked to be remembered; with it, a sign-in skips the authenticator code",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  deviceToken?: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  refreshToken!: string;
}

export class TokenPairResponse {
  @ApiProperty({ enum: ["Bearer"] })
  tokenType!: "Bearer";

  @ApiProperty()
  accessToken!: string;

  @ApiProperty({ description: "Access token lifetime in seconds" })
  expiresIn!: number;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty({
    required: false,
    description:
      "Only when the sign-in asked to remember the device: keep it on the device and send it with later sign-ins",
  })
  deviceToken?: string;
}

export class MfaChallengeResponse {
  @ApiProperty({ enum: [true] })
  mfaRequired!: true;

  @ApiProperty({ description: "Single-use token for POST /auth/login/mfa; valid for 5 minutes" })
  mfaToken!: string;
}

export class LoginMfaDto {
  @ApiProperty()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  mfaToken!: string;

  @ApiProperty({ required: false, description: "6-digit code from the authenticator app" })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/)
  code?: string;

  @ApiProperty({ required: false, description: "One of the saved recovery codes" })
  @IsOptional()
  @IsString()
  @Length(5, 32)
  recoveryCode?: string;

  @ApiProperty({ required: false, description: "Remember this device, so it is not asked again" })
  @IsOptional()
  @IsBoolean()
  trustDevice?: boolean;
}

export class ConfirmMfaDto {
  @ApiProperty({ description: "6-digit code from the authenticator app" })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

export class DisableMfaDto {
  @ApiProperty()
  @IsString()
  @Length(1, 1024)
  password!: string;

  @ApiProperty({ description: "6-digit code from the authenticator app" })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

export class EnrolMfaResponse {
  @ApiProperty({ description: "Base32 secret to type into an authenticator app" })
  secret!: string;

  @ApiProperty({ description: "otpauth:// link for a QR code" })
  otpauthUri!: string;
}

export class RecoveryCodesResponse {
  @ApiProperty({ type: [String], description: "Shown once; each works one time" })
  recoveryCodes!: string[];

  @ApiProperty({
    required: false,
    description: "The device that turned the app on is remembered: keep this secret on it",
  })
  deviceToken?: string;
}
