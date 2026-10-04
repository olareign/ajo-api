import { Injectable } from "@nestjs/common";

/**
 * How many things (saving plans, èsúsú circles) currently depend on a person's auto-debit. A mandate
 * cannot be cancelled while this is above nothing. Plans and circles arrive in later phases, so for
 * now there is nothing to depend on it.
 */
@Injectable()
export class ActiveCommitments {
  async count(_userId: string): Promise<number> {
    return 0;
  }
}
