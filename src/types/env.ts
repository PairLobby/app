export interface Env {
  JWT_SECRET: string;
  CORS_ORIGIN?: string;
  USERS: KVNamespace;
}
