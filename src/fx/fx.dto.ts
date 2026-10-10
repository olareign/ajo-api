import { ApiProperty } from "@nestjs/swagger";

export class EquivalentResponse {
  @ApiProperty({ example: "GBP" }) currency!: string;
  @ApiProperty({ description: "Minor units, rounded", example: "1240" }) amount!: string;
  @ApiProperty({
    description: "Units of this currency for one unit of the wallet's",
    example: "0.0005",
  })
  rate!: string;
}

export class WalletEquivalentsResponse {
  @ApiProperty({ example: "NGN" }) currency!: string;
  @ApiProperty({ description: "Available, locked and saved together, minor units" }) total!: string;
  @ApiProperty({ type: [EquivalentResponse] }) equivalents!: EquivalentResponse[];
}

export class FxEquivalentsResponse {
  @ApiProperty({ description: "False when no rate source is set; nothing else is filled in then" })
  available!: boolean;
  @ApiProperty({ nullable: true, description: "When the rates were true" }) asOf!: string | null;
  @ApiProperty({ description: "The source was down, so these are the last good rates" })
  stale!: boolean;
  @ApiProperty({ description: "True for made-up development rates" }) sample!: boolean;
  @ApiProperty({ type: [WalletEquivalentsResponse] }) wallets!: WalletEquivalentsResponse[];
}
