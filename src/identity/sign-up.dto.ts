import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsEmail, IsString, Length, Matches, MaxLength } from "class-validator";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export class SignUpDto {
  @ApiProperty({ example: "ada@example.com" })
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  /** Length and breach rules are checked by the password policy; this only bounds the input. */
  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString()
  @Length(1, 1024)
  password!: string;

  @ApiProperty({ example: "Ada" })
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  displayName!: string;
}

export class VerifyEmailDto {
  @ApiProperty({ description: "Token from the verification link" })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token!: string;
}

export class ResendVerificationDto {
  @ApiProperty({ example: "ada@example.com" })
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class MessageResponse {
  @ApiProperty()
  message!: string;
}

export class VerifiedResponse {
  @ApiProperty()
  verified!: boolean;
}
