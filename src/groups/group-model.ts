import { sql } from "../database/sql.js";
import type { GroupFrequency, OrderMethod, Visibility } from "./group-rules.js";

export type Tx = Parameters<typeof sql>[0];

export type GroupStatus = "open" | "picking" | "running" | "completed" | "cancelled";

export type GroupRow = {
  id: string;
  creator_id: string;
  name: string;
  community: string | null;
  currency: string;
  contribution: string;
  frequency: GroupFrequency;
  size: number;
  start_date: string;
  time_zone: string;
  order_method: OrderMethod;
  visibility: Visibility;
  invite_code: string;
  status: GroupStatus;
  deposit_base: string;
  deposit_early: string;
  fee_bps: number;
  late_fee_bps: number;
  grace_days: number;
  pick_deadline: Date | null;
  locked_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  request_hash: string;
  created_at: Date;
};

export const GROUP_COLUMNS = `id, creator_id, name, community, currency, contribution::text, frequency, size,
  start_date::text, time_zone, order_method, visibility, invite_code, status, deposit_base::text, deposit_early::text,
  fee_bps, late_fee_bps, grace_days, pick_deadline, locked_at, completed_at, cancelled_at, request_hash, created_at`;

export type MemberRow = {
  group_id: string;
  user_id: string;
  join_seq: number;
  spot: number | null;
  deposit_required: string;
  status: "active" | "left";
};

export const MEMBER_COLUMNS = `group_id, user_id, join_seq, spot, deposit_required::text, status`;

/** The ledger account a member's deposit sits in, and the pot each round is collected into. */
export const depositRef = (groupId: string) => `group:${groupId}:deposit`;
export const potRef = (groupId: string, round: number) => `group:${groupId}:r${round}`;

export const money = (amount: string | bigint, currency: string) => ({
  amount: amount.toString(),
  currency,
});
