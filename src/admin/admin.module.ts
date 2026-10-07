import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { KycModule } from "../kyc/kyc.module.js";
import { AdminAudit } from "./admin-audit.service.js";
import { AdminAuth } from "./admin-auth.service.js";
import { AdminCases } from "./admin-cases.service.js";
import { AdminCompliance } from "./admin-compliance.service.js";
import { AdminPeople } from "./admin-people.service.js";
import {
  AdminAuditController,
  AdminCasesController,
  AdminComplianceController,
  AdminPeopleController,
  AdminSessionController,
  AdminTeamController,
} from "./admin.controller.js";
import { AdminGuard } from "./admin.guard.js";

/** The staff back office: its own sign-in, its own sessions, and a log of everything staff do. */
@Module({
  imports: [AuthModule, IdentityModule, KycModule],
  controllers: [
    AdminSessionController,
    AdminPeopleController,
    AdminComplianceController,
    AdminCasesController,
    AdminAuditController,
    AdminTeamController,
  ],
  providers: [AdminAudit, AdminAuth, AdminPeople, AdminCompliance, AdminCases, AdminGuard],
})
export class AdminModule {}
