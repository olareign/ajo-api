import { ApiProperty } from "@nestjs/swagger";
import { KYC_STEPS } from "./kyc-status.js";

export class KycStepResponse {
  @ApiProperty({ enum: KYC_STEPS }) step!: string;
  @ApiProperty({ description: "False for the optional national check (BVN in Nigeria)" })
  required!: boolean;
  @ApiProperty({ enum: ["not_started", "pending", "approved", "rejected"] }) status!: string;
  @ApiProperty({ nullable: true, description: "Why a step was refused, in words for the person" })
  reason!: string | null;
}

export class KycResponse {
  @ApiProperty({
    description: "False until an identity partner is connected: steps cannot be sent",
  })
  connected!: boolean;
  @ApiProperty({ enum: ["NG", "GB"], nullable: true }) country!: string | null;
  @ApiProperty({ enum: ["not_started", "in_progress", "pending", "approved", "rejected"] })
  status!: string;
  @ApiProperty({ enum: [0, 1, 2], description: "2 once the national check is also approved" })
  tier!: number;
  @ApiProperty({ type: [KycStepResponse] }) steps!: KycStepResponse[];
  @ApiProperty({
    enum: ["checks", "waived", "hold"],
    description:
      "Where status comes from: the identity checks, an approval without them while they are not switched on (waived), or a hold on the account",
  })
  via!: string;
  @ApiProperty({
    nullable: true,
    description: "A sentence for the person when status is not from the checks",
  })
  note!: string | null;
}
