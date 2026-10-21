import { argon2id, hash, verify } from 'argon2';
import type { AccountCrypto } from './crypto.js';

const options = { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1, hashLength: 32 };
// A missing account takes the same password-hash verification path.
const dummy = hash('unusable-account-password', options);
export class Passwords {
  constructor(private readonly crypto: AccountCrypto) {}
  async protect(password: string) {
    const digest = await hash(this.crypto.mac('password:v1:' + password), options);
    return this.crypto.encrypt(digest);
  }
  async matches(password: string, protectedHash: string | null | undefined) {
    let digest = await dummy;
    if (protectedHash) {
      try {
        digest = this.crypto.decrypt(protectedHash);
      } catch {
        /* Fail closed. */
      }
    }
    try {
      const valid = await verify(digest, this.crypto.mac('password:v1:' + password));
      return Boolean(protectedHash) && valid;
    } catch {
      return false;
    }
  }
}
