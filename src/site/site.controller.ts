import { Controller, Get, Header } from "@nestjs/common";
import { ApiOkResponse, ApiProperty, ApiTags } from "@nestjs/swagger";
import { Public } from "../auth/public.decorator.js";
import { SiteSettings } from "./site-settings.service.js";

export class SupportContactResponse {
  @ApiProperty({ example: "info@ajo.com" }) supportEmail!: string;
}

@ApiTags("site")
@Controller("site")
export class SiteController {
  constructor(private readonly settings: SiteSettings) {}

  /** The address customers write to for help. Public: it is printed on Help and the legal pages. */
  @Public()
  @Get("contact")
  @Header("Cache-Control", "public, max-age=60")
  @ApiOkResponse({ type: SupportContactResponse })
  async contact(): Promise<SupportContactResponse> {
    // Only the address: who changed it, and when, is for staff.
    const { supportEmail } = await this.settings.supportContact();
    return { supportEmail };
  }
}
