import { readExtractOutput } from "@/core/extraction/extract";
import { chosenRole } from "@/core/extraction/owner";
import type { StageDefinition, StageResult } from "@/core/platform/runner";
import type { Db, Dns } from "@/core/ports";

import { type AddressCheck, checkAddress } from "./addressChecks";

/**
 * The `address_checks` stage (review spec, "Stage address_checks"): the
 * chosen email address's checks, beside draft. Its input is the address as
 * it stands, which is the extracted one until the owner can retype it, and
 * the company the name check reads; a later lookup of the same address is
 * the same result reused, so a DNS answer is kept as first found.
 */

/** Raise it when addressChecks.ts changes what it finds, so a kept result is not reused. */
const CHECKS_VERSION = 1;

export interface AddressChecksOutput {
  checked: true;
  address: string;
  checks: AddressCheck[];
}

interface AddressChecksInput {
  address: string;
  company: string;
  version: number;
}

export function addressChecksStage(deps: { db: Db; dns: Dns }): StageDefinition {
  return {
    callsModel: false,

    async input(ctx): Promise<AddressChecksInput> {
      const extraction = readExtractOutput((await ctx.outputOf("extract"))?.output);
      const role = await chosenRole(deps.db, ctx.job.id);
      if (!extraction || role?.route.kind !== "email") {
        throw new Error("address_checks runs only for a chosen email route");
      }
      return {
        address: role.route.address.trim(),
        company: extraction.record.company.name,
        version: CHECKS_VERSION,
      };
    },

    async run(_ctx, raw): Promise<StageResult> {
      const input = raw as AddressChecksInput;
      const output: AddressChecksOutput = {
        checked: true,
        address: input.address,
        checks: await checkAddress(deps.dns, input.address, input.company),
      };
      return { ok: true, output };
    },
  };
}
