import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * One row per person per verification step: waiting, approved or refused (with the reason shown to
 * them). Overall status and tier are worked out from these rows, never stored, so they cannot drift.
 */
export class CreateKycSteps1790900080000 implements MigrationInterface {
  name = "CreateKycSteps1790900080000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE kyc_steps (
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        step text NOT NULL
          CHECK (step IN ('id', 'selfie', 'address', 'location', 'bank', 'national_check')),
        status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
        reason text CHECK (char_length(reason) <= 300),
        provider_ref text CHECK (char_length(provider_ref) <= 200),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, step)
      )`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE kyc_steps`);
  }
}
