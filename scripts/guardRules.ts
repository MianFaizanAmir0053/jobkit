/**
 * The commit guard's rules (platform spec B7), kept pure so they can be
 * tested without git. `guard.ts` feeds them staged files, the tree, or the
 * commits a push adds.
 */

const ONE_MB = 1024 * 1024;

const KEY_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "Anthropic key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "Google API key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
  // The newer form AI Studio issues for Gemini.
  { name: "Google API key", pattern: /\bAQ\.[A-Za-z0-9_-]{40,}/ },
  { name: "Google OAuth client secret", pattern: /GOCSPX-[A-Za-z0-9_-]{20,}/ },
  { name: "Supabase secret key", pattern: /sb_secret_[A-Za-z0-9_-]{20,}/ },
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: "JWT-shaped string",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
];

// postgres:// or postgresql:// with a user and a password before the @.
const CONNECTION_STRING = /postgres(?:ql)?:\/\/[^\s:/@]+:([^\s@/]+)@/g;

// Passwords the docs use as placeholders, which are not secrets.
const PLACEHOLDER_PASSWORDS = new Set(["password", "pass", "pwd", "secret", "changeme", "***"]);

// Variable names whose values are secrets; others (an address, a URL) are not.
const SECRET_NAME = /(SECRET|_KEY|PASSWORD|TOKEN|DATABASE_URL|BOOTSTRAP_URL)$/;

export function checkPath(path: string): string | null {
  const normalised = path.replace(/\\/g, "/");
  // At any depth and in any case: a script run from another folder makes its own .data/.
  const folders = normalised.toLowerCase().split("/");
  if (folders.includes("private")) {
    return `${path}: files under private/ never enter git`;
  }
  // The local database and its files hold copies of the owner's profile and CV.
  if (folders.includes(".data")) {
    return `${path}: files under .data/ never enter git`;
  }
  const base = normalised.split("/").pop() ?? normalised;
  if (base.startsWith(".env") && base !== ".env.example") {
    return `${path}: .env files never enter git (only .env.example)`;
  }
  return null;
}

export function checkSize(bytes: number): string | null {
  return bytes > ONE_MB ? `file is larger than 1 MB (${bytes} bytes)` : null;
}

export function checkContent(text: string, knownSecrets: readonly string[]): string[] {
  const found: string[] = [];
  for (const { name, pattern } of KEY_PATTERNS) {
    if (pattern.test(text)) found.push(`looks like a ${name}`);
  }
  for (const match of text.matchAll(CONNECTION_STRING)) {
    const password = match[1] ?? "";
    const placeholder =
      PLACEHOLDER_PASSWORDS.has(password.toLowerCase()) || /^[<${]/.test(password);
    if (!placeholder) {
      found.push("contains a database connection string with a password");
      break;
    }
  }
  for (const secret of knownSecrets) {
    if (text.includes(secret)) found.push("contains a value from the local env files");
  }
  return found;
}

export function knownSecretsFrom(envFileText: string): string[] {
  const secrets: string[] = [];
  for (const line of envFileText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (SECRET_NAME.test(name) && value.length >= 12) secrets.push(value);
  }
  return secrets;
}

/**
 * The commits a push adds. A new branch (all-zero `before`) adds those not on
 * main; with no main to compare against, as on a repository's first push,
 * that is the whole history.
 */
export function pushRange(before: string, after: string, opts: { mainIsBase: boolean }): string {
  if (!/^0+$/.test(before)) return `${before}..${after}`;
  return opts.mainIsBase ? `origin/main..${after}` : after;
}
