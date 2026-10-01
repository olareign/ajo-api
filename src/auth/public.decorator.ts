import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "isPublic";

/** Opts a route out of authentication. Everything else requires a valid session. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
