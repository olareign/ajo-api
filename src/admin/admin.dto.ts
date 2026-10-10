import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from "class-validator";
import { ADMIN_ROLES, type AdminRole } from "./admin-roles.js";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
const lower = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim().toLowerCase() : value;
const SIX = /^\d{6}$/;

export class AdminLoginDto {
  @ApiProperty() @Transform(lower) @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty() @IsString() @Length(1, 1024) password!: string;
  @ApiProperty({ description: "6-digit code from the authenticator app" })
  @IsString()
  @Matches(SIX)
  code!: string;
}

export class AdminSetupStartDto {
  @ApiProperty() @Transform(lower) @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty() @IsString() @Length(10, 60) setupCode!: string;
  @ApiProperty() @IsString() @Length(1, 1024) password!: string;
}

export class AdminSetupConfirmDto {
  @ApiProperty() @Transform(lower) @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty() @IsString() @Length(10, 60) setupCode!: string;
  @ApiProperty() @IsString() @Matches(SIX) code!: string;
}

/** The fresh code that every sensitive action asks for, and the reason it is done. */
export class ActionDto {
  @ApiProperty({ description: "A fresh 6-digit code from the authenticator app" })
  @IsString()
  @Matches(SIX)
  code!: string;

  @ApiProperty({ description: "Why, in a sentence; kept in the audit log" })
  @Transform(trim)
  @IsString()
  @Length(5, 300)
  reason!: string;
}

export class KycStepDecisionDto extends ActionDto {
  @ApiProperty({ enum: ["approved", "rejected"] }) @IsIn(["approved", "rejected"]) decision!:
    "approved" | "rejected";
}

export class KycOverrideDto extends ActionDto {
  @ApiProperty({ enum: ["approve", "deny", "clear"] }) @IsIn(["approve", "deny", "clear"]) action!:
    "approve" | "deny" | "clear";
}

export class CaseNoteDto {
  @ApiProperty() @Transform(trim) @IsString() @Length(1, 1000) note!: string;
}

export class CaseOutcomeDto extends ActionDto {
  @ApiProperty({ enum: ["resolved", "written_off"] }) @IsIn(["resolved", "written_off"]) outcome!:
    "resolved" | "written_off";
}

export class InviteAdminDto {
  @ApiProperty() @Transform(lower) @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty() @Transform(trim) @IsString() @Length(1, 80) name!: string;
  @ApiProperty({ enum: ADMIN_ROLES }) @IsIn(ADMIN_ROLES) role!: AdminRole;
  @ApiProperty() @IsString() @Matches(SIX) code!: string;
}

export class StepUpDto {
  @ApiProperty() @IsString() @Matches(SIX) code!: string;
}

export class UserSearchQuery {
  @ApiProperty({
    description: "An email (whole), or the start of a username, at least 3 characters",
  })
  @Transform(lower)
  @IsString()
  @Length(3, 254)
  q!: string;
}

export class AuditQuery {
  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(lower)
  @IsString()
  @MaxLength(254)
  admin?: string;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^[a-z_.:]+$/)
  action?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(80) target?: string;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,18}$/)
  before?: string;
}

export class SupportEmailDto extends ActionDto {
  @ApiProperty({ example: "info@ajo.com", description: "The address customers write to for help" })
  @Transform(lower)
  @IsEmail({ require_tld: true, allow_display_name: false, allow_ip_domain: false })
  @MaxLength(254)
  email!: string;
}
