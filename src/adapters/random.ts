import { randomBytes } from "node:crypto";

import type { Random } from "@/core/ports";

export const cryptoRandom: Random = { bytes: (length) => new Uint8Array(randomBytes(length)) };
