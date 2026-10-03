import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsIn, IsString, Matches } from "class-validator";
import { normalizeUsername, USERNAME_PATTERN } from "./username-policy.js";

export const COUNTRIES = ["NG", "GB"] as const;
export const GOALS = ["solo", "circle", "both"] as const;

export class UpdateProfileDto {
  @ApiProperty({ enum: COUNTRIES })
  @IsIn(COUNTRIES)
  country!: (typeof COUNTRIES)[number];

  @ApiProperty({ enum: GOALS })
  @IsIn(GOALS)
  goal!: (typeof GOALS)[number];
}

export class PinDto {
  @ApiProperty({ description: "Six digits" })
  @IsString()
  @Matches(/^\d{6}$/)
  pin!: string;
}

const normalise = ({ value }: { value: unknown }) =>
  typeof value === "string" ? normalizeUsername(value) : value;

export class SetUsernameDto {
  @ApiProperty({
    example: "ada_ola",
    description: "3 to 20 characters: a letter first, then letters, digits or underscores",
  })
  @Transform(normalise)
  @IsString()
  @Matches(USERNAME_PATTERN)
  username!: string;
}

export class UsernameAvailableQuery {
  @ApiProperty({ example: "ada_ola" })
  @Transform(normalise)
  @IsString()
  @Matches(USERNAME_PATTERN)
  username!: string;
}

export class UsernameAvailableResponse {
  @ApiProperty() available!: boolean;
}
