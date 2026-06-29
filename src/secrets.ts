import { Entry } from '@napi-rs/keyring';

const SERVICE = 'subtrack';

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

export class KeyringSecretStore implements SecretStore {
  private entry(key: string): Entry {
    return new Entry(SERVICE, key);
  }
  async get(key: string): Promise<string | null> {
    try {
      return this.entry(key).getPassword();
    } catch {
      return null; // not found
    }
  }
  async set(key: string, value: string): Promise<void> {
    this.entry(key).setPassword(value);
  }
  async delete(key: string): Promise<void> {
    try {
      this.entry(key).deletePassword();
    } catch {
      // already absent
    }
  }
}

export function defaultSecretStore(): SecretStore {
  return new KeyringSecretStore();
}
