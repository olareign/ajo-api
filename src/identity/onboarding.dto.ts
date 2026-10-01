import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsString, Matches } from "class-validator";

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
