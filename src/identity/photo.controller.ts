import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Put,
  Req,
  Res,
  ServiceUnavailableException,
  StreamableFile,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import type { AccessClaims } from "../auth/access-tokens.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { PHOTO_MAX_BYTES } from "./photo-image.js";
import { PhotoService } from "./photo.service.js";

const HOUR = 60 * 60 * 1000;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export class PhotoSetResponse {
  version!: number;
}

@ApiTags("profile")
@ApiBearerAuth()
@Controller()
export class PhotoController {
  constructor(private readonly photos: PhotoService) {}

  /**
   * The body is the picture itself (JPEG, PNG or WebP, at most 5 MB; the app sends it already cropped
   * square and small). It is checked by its bytes, redrawn, and stored privately.
   */
  @Put("me/photo")
  @Throttle({ default: { limit: 10, ttl: HOUR } })
  @ApiConsumes(...IMAGE_TYPES)
  @ApiBody({ schema: { type: "string", format: "binary" } })
  @ApiOkResponse({ type: PhotoSetResponse })
  async set(@CurrentUser() auth: AccessClaims, @Req() req: Request): Promise<PhotoSetResponse> {
    if (!this.photos.enabled) throw off();
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0)
      throw new BadRequestException({
        message: "Send a JPEG, PNG or WebP picture.",
        code: "photo_unsupported",
      });
    if (body.length > PHOTO_MAX_BYTES)
      throw new PayloadTooLargeException({
        message: "That picture is larger than 5 MB.",
        code: "photo_too_large",
      });
    const result = await this.photos.set(auth.userId, body);
    if (!result.ok) {
      if (result.problem === "off") throw off();
      throw new BadRequestException({
        message:
          result.problem === "unsupported"
            ? "Send a JPEG, PNG or WebP picture."
            : "We couldn't read that picture. Try another one.",
        code: result.problem === "unsupported" ? "photo_unsupported" : "photo_unreadable",
      });
    }
    return { version: result.version };
  }

  @Delete("me/photo")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async remove(@CurrentUser() auth: AccessClaims): Promise<void> {
    await this.photos.remove(auth.userId);
  }

  /**
   * Someone's photo, if you may see it (yours, a friend's, or a request you have open). Cached by the
   * browser for a day, per version, so it is fetched once.
   */
  @Get("photos/:username")
  @Throttle({ default: { limit: 300, ttl: 60 * 1000 } })
  @ApiOkResponse({ description: "The image (WebP)" })
  async view(
    @CurrentUser() auth: AccessClaims,
    @Param("username") username: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const found = await this.photos.read(auth.userId, username.slice(0, 40));
    if (!found.found) throw new NotFoundException();
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("ETag", `"${found.version}"`);
    return new StreamableFile(found.body, { type: found.contentType });
  }
}

const off = () =>
  new ServiceUnavailableException({
    message: "Profile pictures aren't switched on yet.",
    code: "photos_off",
  });
