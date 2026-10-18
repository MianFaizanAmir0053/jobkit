import { onVercelDeployment } from "@/server/deployEnv";

/**
 * The values the app reads per request (platform spec B8), checked once.
 * Production fails closed: without its origin or Google client it refuses to
 * start rather than run half-configured. An empty OWNER_EMAIL is allowed and
 * admits nobody (B2).
 */
export interface AppConfig {
  /** The app's own origin, such as https://jobkit.example.com, with no path. */
  appOrigin: string;
  ownerEmail: string;
  google: { clientId: string; clientSecret: string };
}

type Env = Readonly<Record<string, string | undefined>>;

export function readAppConfig(env: Env): AppConfig {
  if (onVercelDeployment(env) && env.JOBKIT_ENV !== "production") {
    throw new Error(
      `This is a Vercel ${env.VERCEL_ENV} deployment, so JOBKIT_ENV must be production`,
    );
  }
  const production = env.JOBKIT_ENV === "production";
  const appOrigin = env.APP_ORIGIN || (production ? "" : "http://localhost:3000");
  if (!isOrigin(appOrigin)) {
    throw new Error(
      `APP_ORIGIN must be an origin such as https://jobkit.example.com, with no path or trailing slash; it is ${JSON.stringify(appOrigin)}`,
    );
  }
  if (production && !appOrigin.startsWith("https://")) {
    throw new Error("APP_ORIGIN must use https in production");
  }
  const google = {
    clientId: env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
  };
  if (production) {
    const missing = Object.entries({
      GOOGLE_CLIENT_ID: google.clientId,
      GOOGLE_CLIENT_SECRET: google.clientSecret,
    }).filter(([, value]) => !value);
    if (missing.length > 0) {
      throw new Error(`Missing for production: ${missing.map(([name]) => name).join(", ")}`);
    }
  }
  return { appOrigin, ownerEmail: env.OWNER_EMAIL ?? "", google };
}

function isOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

let cached: AppConfig | undefined;

/** The process's configuration, read from its environment on first use. */
export function appConfig(): AppConfig {
  cached ??= readAppConfig(process.env);
  return cached;
}
