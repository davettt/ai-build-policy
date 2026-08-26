// BYOK secret storage — canonical implementation.
//
// Scaffolded by `policy scaffold`. Electron's `safeStorage` is NOT used and
// `policy check` FAILs a project that imports it: its encrypted values go stale
// across app re-signs and updates, which surfaces to the user as a macOS
// keychain prompt and a key that no longer decrypts.
//
// The key is derived from the machine, so a copied config file does not carry
// usable secrets to another machine. Values are prefixed `enc:` and plaintext
// is passed through unchanged, so existing installs migrate on first write.
//
// CBC rather than GCM is deliberate, and has been re-raised three times by
// reviewers reading this file without the decision record. What this buys is
// machine-binding, not confidentiality against local code: `hostname` and
// `username` are readable, so anyone who can read this config can derive the
// key. Authenticated encryption guards the write-but-cannot-read attacker,
// which does not exist here, so GCM would cost a format change and a migration
// across every shipping app while closing no open gap. A keychain-held root key
// was rejected separately: macOS keychain ACLs bind to the code signature, so a
// re-signed build loses access — the exact failure that forced the migration
// off Electron `safeStorage`.
//
// Full reasoning and the revisit trigger: project-standards § Secret storage.
// Do not change this scheme without agreeing a standards change first.
//
// Replace <appname> below with this app's name, lowercase, no spaces.

import crypto from 'node:crypto';
import os from 'node:os';

const MACHINE_SEED = `<appname>:${os.hostname()}:${os.userInfo().username}`;
const ENCRYPTION_KEY = crypto.createHash('sha256').update(MACHINE_SEED).digest();

export function encryptKey(plaintext) {
  if (!plaintext) return plaintext;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return 'enc:' + iv.toString('hex') + ':' + encrypted;
}

export function decryptKey(stored) {
  if (!stored) return stored;
  // Plaintext from an older install: returned as-is, re-encrypted on next write.
  if (!stored.startsWith('enc:')) return stored;
  try {
    const parts = stored.split(':');
    const iv = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(parts[2], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    // Key derived on a different machine, or corrupted value.
    return stored;
  }
}
