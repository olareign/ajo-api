import { EnableExtensions1790900000000 } from "./1790900000000-enable-extensions.js";
import { CreateUsers1790900001000 } from "./1790900001000-create-users.js";
import { CreateSessions1790900002000 } from "./1790900002000-create-sessions.js";
import { CreateLedger1790900020000 } from "./1790900020000-create-ledger.js";
import { CreateOnboarding1790900030000 } from "./1790900030000-create-onboarding.js";
import { CreateMfa1790900011000 } from "./1790900011000-create-mfa.js";
import { AddEmailVerified1790900040000 } from "./1790900040000-add-email-verified.js";
import { AddRetentionSupport1790900041000 } from "./1790900041000-add-retention-support.js";
import { AddUsername1790900050000 } from "./1790900050000-add-username.js";
import { CreatePasswordResetTokens1790900010000 } from "./1790900010000-create-password-reset-tokens.js";

/** Every migration, in order. Listed explicitly so builds and ESM loading never miss one. */
export const migrations = [
  EnableExtensions1790900000000,
  CreateUsers1790900001000,
  CreateSessions1790900002000,
  CreatePasswordResetTokens1790900010000,
  CreateMfa1790900011000,
  CreateLedger1790900020000,
  CreateOnboarding1790900030000,
  AddEmailVerified1790900040000,
  AddRetentionSupport1790900041000,
  AddUsername1790900050000,
];
