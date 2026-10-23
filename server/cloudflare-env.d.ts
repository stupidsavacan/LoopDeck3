declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    SYNC_PASSPHRASE?: string;
    ALLOWED_ORIGINS?: string;
    ALLOW_NULL_ORIGIN?: string;
  }
}
