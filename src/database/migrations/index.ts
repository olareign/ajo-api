import { EnableExtensions1790900000000 } from "./1790900000000-enable-extensions.js";
import { CreateUsers1790900001000 } from "./1790900001000-create-users.js";

/** Every migration, in order. Listed explicitly so builds and ESM loading never miss one. */
export const migrations = [EnableExtensions1790900000000, CreateUsers1790900001000];
