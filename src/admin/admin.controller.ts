import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { Public } from "../auth/public.decorator.js";
import { AdminAudit } from "./admin-audit.service.js";
import { AdminAuth } from "./admin-auth.service.js";
import { AdminCases } from "./admin-cases.service.js";
import { AdminCompliance } from "./admin-compliance.service.js";
import { AdminPeople } from "./admin-people.service.js";
import { AdminSettings } from "./admin-settings.service.js";
import { CurrentAdmin, type AdminPrincipal } from "./admin-principal.js";
import { permissionsOf } from "./admin-roles.js";
import { AdminRoute } from "./admin.guard.js";
import {
  ActionDto,
  AdminLoginDto,
  AdminSetupConfirmDto,
  AdminSetupStartDto,
  AuditQuery,
  CaseNoteDto,
  CaseOutcomeDto,
  InviteAdminDto,
  KycOverrideDto,
  KycStepDecisionDto,
  StepUpDto,
  SupportEmailDto,
  UserSearchQuery,
} from "./admin.dto.js";

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const client = (req: Request) => ({ ip: req.ip, userAgent: req.header("user-agent") });
const PAGE = 50;

/** Signing in and out for staff, and the first screen. */
@ApiTags("admin")
@Controller("admin")
export class AdminSessionController {
  constructor(
    private readonly auth: AdminAuth,
    private readonly people: AdminPeople,
  ) {}

  /** Password and a code from the authenticator app, together, every time. */
  @Public()
  @Post("auth/login")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 8, ttl: FIFTEEN_MINUTES } })
  login(@Body() body: AdminLoginDto, @Req() req: Request) {
    return this.auth.login(body, client(req));
  }

  /** Joining, step 1: the one-time setup code and a password; answers with the key for the authenticator app. */
  @Public()
  @Post("auth/setup/start")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: FIFTEEN_MINUTES } })
  setupStart(@Body() body: AdminSetupStartDto) {
    return this.auth.startSetup(body);
  }

  /** Joining, step 2: a code from the app proves it works, and the member is signed in. */
  @Public()
  @Post("auth/setup/confirm")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: FIFTEEN_MINUTES } })
  setupConfirm(@Body() body: AdminSetupConfirmDto, @Req() req: Request) {
    return this.auth.confirmSetup(body, client(req));
  }

  @AdminRoute()
  @Post("auth/logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@CurrentAdmin() admin: AdminPrincipal): Promise<void> {
    await this.auth.logout(admin);
  }

  @AdminRoute()
  @Get("me")
  me(@CurrentAdmin() admin: AdminPrincipal) {
    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      permissions: permissionsOf(admin.role),
    };
  }

  @AdminRoute("overview:read")
  @Get("overview")
  overview() {
    return this.people.overview();
  }
}

@ApiTags("admin")
@Controller("admin/users")
export class AdminPeopleController {
  constructor(
    private readonly people: AdminPeople,
    private readonly auth: AdminAuth,
  ) {}

  @AdminRoute("users:read")
  @Get("search")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  search(@CurrentAdmin() admin: AdminPrincipal, @Query() query: UserSearchQuery) {
    return this.people.search(admin, query.q);
  }

  @AdminRoute("users:read")
  @Get(":id")
  detail(@CurrentAdmin() admin: AdminPrincipal, @Param("id", ParseUUIDPipe) id: string) {
    return this.people.detail(admin, id);
  }

  @AdminRoute("users:suspend")
  @Post(":id/suspend")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 20, ttl: FIFTEEN_MINUTES } })
  async suspend(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ActionDto,
  ): Promise<void> {
    await this.auth.stepUp(admin.id, body.code);
    await this.people.suspend(admin, id, body.reason);
  }

  @AdminRoute("users:reinstate")
  @Post(":id/reinstate")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 20, ttl: FIFTEEN_MINUTES } })
  async reinstate(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ActionDto,
  ): Promise<void> {
    await this.auth.stepUp(admin.id, body.code);
    await this.people.reinstate(admin, id, body.reason);
  }
}

@ApiTags("admin")
@Controller("admin/kyc")
export class AdminComplianceController {
  constructor(
    private readonly compliance: AdminCompliance,
    private readonly auth: AdminAuth,
  ) {}

  @AdminRoute("kyc:read")
  @Get()
  queue(@CurrentAdmin() admin: AdminPrincipal) {
    return this.compliance.queue(admin);
  }

  @AdminRoute("kyc:read")
  @Get(":userId")
  detail(@CurrentAdmin() admin: AdminPrincipal, @Param("userId", ParseUUIDPipe) userId: string) {
    return this.compliance.detail(admin, userId);
  }

  @AdminRoute("kyc:decide")
  @Post(":userId/steps/:step")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 30, ttl: FIFTEEN_MINUTES } })
  async decideStep(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Param("step") step: string,
    @Body() body: KycStepDecisionDto,
  ): Promise<void> {
    await this.auth.stepUp(admin.id, body.code);
    await this.compliance.decideStep(admin, userId, step, body.decision, body.reason);
  }

  @AdminRoute("kyc:decide")
  @Post(":userId/override")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 20, ttl: FIFTEEN_MINUTES } })
  async override(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Body() body: KycOverrideDto,
  ): Promise<void> {
    await this.auth.stepUp(admin.id, body.code);
    await this.compliance.override(admin, userId, body.action, body.reason);
  }
}

@ApiTags("admin")
@Controller("admin/cases")
export class AdminCasesController {
  constructor(
    private readonly cases: AdminCases,
    private readonly auth: AdminAuth,
  ) {}

  @AdminRoute("cases:read")
  @Get()
  list(
    @CurrentAdmin() admin: AdminPrincipal,
    @Query("status", new ParseEnumPipe(["open", "resolved", "written_off"], { optional: true }))
    status?: "open" | "resolved" | "written_off",
  ) {
    return this.cases.list(admin, status ?? "open");
  }

  @AdminRoute("cases:read")
  @Get(":id")
  detail(@CurrentAdmin() admin: AdminPrincipal, @Param("id", ParseUUIDPipe) id: string) {
    return this.cases.detail(admin, id);
  }

  @AdminRoute("cases:write")
  @Post(":id/notes")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 60, ttl: FIFTEEN_MINUTES } })
  async note(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: CaseNoteDto,
  ): Promise<void> {
    await this.cases.addNote(admin, id, body.note);
  }

  @AdminRoute("cases:write")
  @Post(":id/close")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 20, ttl: FIFTEEN_MINUTES } })
  async close(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: CaseOutcomeDto,
  ): Promise<void> {
    await this.auth.stepUp(admin.id, body.code);
    await this.cases.close(admin, id, body.outcome, body.reason);
  }
}

@ApiTags("admin")
@Controller("admin/audit")
export class AdminAuditController {
  constructor(private readonly audit: AdminAudit) {}

  /** Newest first. Reading the log is itself kept in the log. */
  @AdminRoute("audit:read")
  @Get()
  @ApiOkResponse({ description: "A page of the audit log" })
  async list(@CurrentAdmin() admin: AdminPrincipal, @Query() query: AuditQuery) {
    const page = await this.audit.list({
      admin: query.admin,
      action: query.action,
      target: query.target,
      before: query.before,
      limit: PAGE,
    });
    await this.audit.record(admin, "audit.view", "ok", undefined, {
      admin: query.admin,
      action: query.action,
      target: query.target,
    });
    return page;
  }
}

@ApiTags("admin")
@Controller("admin/team")
export class AdminTeamController {
  constructor(private readonly auth: AdminAuth) {}

  @AdminRoute("team:manage")
  @Get()
  team() {
    return this.auth.team();
  }

  /** Adds a member and answers with their one-time setup code, shown once, to pass to them yourself. */
  @AdminRoute("team:manage")
  @Post()
  @Throttle({ default: { limit: 20, ttl: FIFTEEN_MINUTES } })
  async invite(@CurrentAdmin() admin: AdminPrincipal, @Body() body: InviteAdminDto) {
    await this.auth.stepUp(admin.id, body.code);
    return this.auth.invite(admin, body);
  }

  /** Wipes a member's password and authenticator and gives a new setup code (for a lost phone). */
  @AdminRoute("team:manage")
  @Post(":id/reissue")
  @Throttle({ default: { limit: 20, ttl: FIFTEEN_MINUTES } })
  async reissue(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: StepUpDto,
  ) {
    await this.auth.stepUp(admin.id, body.code);
    return this.auth.reissue(admin, id);
  }

  @AdminRoute("team:manage")
  @Post(":id/disable")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 20, ttl: FIFTEEN_MINUTES } })
  async disable(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: StepUpDto,
  ): Promise<void> {
    await this.auth.stepUp(admin.id, body.code);
    await this.auth.disable(admin, id);
  }
}

@ApiTags("admin")
@Controller("admin/settings")
export class AdminSettingsController {
  constructor(
    private readonly settings: AdminSettings,
    private readonly auth: AdminAuth,
  ) {}

  /** What customers see today, and who last changed it. */
  @AdminRoute("settings:manage")
  @Get()
  read() {
    return this.settings.read();
  }

  /** Changes the support email shown on Help and the legal pages, with a fresh code and a reason. */
  @AdminRoute("settings:manage")
  @Post("support-email")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 10, ttl: FIFTEEN_MINUTES } })
  async supportEmail(
    @CurrentAdmin() admin: AdminPrincipal,
    @Body() body: SupportEmailDto,
  ): Promise<void> {
    await this.auth.stepUp(admin.id, body.code);
    await this.settings.setSupportEmail(admin, body.email, body.reason);
  }
}
