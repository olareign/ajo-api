import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsEmail, IsString, Length, Matches, MaxLength } from "class-validator";

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
}
