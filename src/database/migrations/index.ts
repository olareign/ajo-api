import { EnableExtensions1790900000000 } from "./1790900000000-enable-extensions.js";
import { CreateUsers1790900001000 } from "./1790900001000-create-users.js";
import { CreateSessions1790900002000 } from "./1790900002000-create-sessions.js";
import { CreateLedger1790900020000 } from "./1790900020000-create-ledger.js";
import { CreateOnboarding1790900030000 } from "./1790900030000-create-onboarding.js";
import { CreateMfa1790900011000 } from "./1790900011000-create-mfa.js";
import { AddEmailVerified1790900040000 } from "./1790900040000-add-email-verified.js";
import { AddRetentionSupport1790900041000 } from "./1790900041000-add-retention-support.js";
import { AddUsername1790900050000 } from "./1790900050000-add-username.js";
import { AddLoginDevices1790900060000 } from "./1790900060000-add-login-devices.js";
import { AddTrustedDevices1790900070000 } from "./1790900070000-add-trusted-devices.js";
import { AddKycOverride1790900140000 } from "./1790900140000-add-kyc-override.js";
import { CustomInviteCodes1790900150000 } from "./1790900150000-custom-invite-codes.js";
import { AccountSecurity1790900160000 } from "./1790900160000-account-security.js";
import { ProfileSettings1790900170000 } from "./1790900170000-profile-settings.js";
import { ProfilePhoto1790900180000 } from "./1790900180000-profile-photo.js";
import { CreateKycSteps1790900080000 } from "./1790900080000-create-kyc-steps.js";
import { CreatePayments1790900090000 } from "./1790900090000-create-payments.js";
import { CreateNotifications1790900100000 } from "./1790900100000-create-notifications.js";
import { CreateSavings1790900110000 } from "./1790900110000-create-savings.js";
import { CreateFriends1790900120000 } from "./1790900120000-create-friends.js";
import { CreateGroups1790900130000 } from "./1790900130000-create-groups.js";
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
  AddLoginDevices1790900060000,
  AddTrustedDevices1790900070000,
  CreateKycSteps1790900080000,
  CreatePayments1790900090000,
  CreateNotifications1790900100000,
  CreateSavings1790900110000,
  CreateFriends1790900120000,
  CreateGroups1790900130000,
  AddKycOverride1790900140000,
  CustomInviteCodes1790900150000,
  AccountSecurity1790900160000,
  ProfileSettings1790900170000,
  ProfilePhoto1790900180000,
];
