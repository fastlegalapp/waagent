'use strict';

const crypto = require('crypto');
const { config } = require('../config');

// AES-256-GCM encryption for secrets at rest (each user's Anthropic API key).
// The 32-byte key is derived from ENCRYPTION_KEY via scrypt so any-length
// secret works. Format stored: base64(iv).base64(tag).base64(ciphertext)

const KEY = crypto.scryptSync(config.encryptionKey || 'unset', 'waagent-enc-v1', 32);

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

function decrypt(blob) {
  if (!blob) return null;
  try {
    const [ivB64, tagB64, ctB64] = blob.split('.');
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (err) {
    return null; // wrong key or corrupted blob
  }
}

module.exports = { encrypt, decrypt };
