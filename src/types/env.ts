export interface KvStore {
  get(key: string): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown | null>;
  put(key: string, value: string): Promise<void>;
}

export interface Env {
  JWT_SECRET: string;
  CORS_ORIGIN?: string;
  USERS: KvStore;
}
