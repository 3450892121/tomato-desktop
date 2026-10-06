// 「文件藏图」的密码层（原版称「图夹 PRO」）—— Node 侧实现，参数与原版逐位一致：
//   key = PBKDF2-SHA256(密码 UTF-8, 盐 'xcn2025', 100000 轮, 256 位)
//   密文 = 12 字节随机 IV ‖ AES-256-GCM(明文) ‖ 16 字节 tag（WebCrypto 的输出顺序）
// 规格：spec/modules/imghide.md
import crypto from 'node:crypto';
import { PASSWORD_SALT_TEXT } from './format.mjs';

const ITERATIONS = 100000;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function deriveKey(password) {
  return crypto.pbkdf2Sync(
    Buffer.from(String(password), 'utf8'),
    Buffer.from(PASSWORD_SALT_TEXT, 'utf8'),
    ITERATIONS,
    KEY_LENGTH,
    'sha256'
  );
}

/**
 * 加密载荷
 * @param {Uint8Array} payload
 * @param {string} password
 * @returns {Uint8Array}
 */
export function encryptPayload(payload, password) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(password), iv, { authTagLength: TAG_LENGTH });
  const body = Buffer.concat([cipher.update(Buffer.from(payload)), cipher.final()]);
  return new Uint8Array(Buffer.concat([iv, body, cipher.getAuthTag()]));
}

/**
 * 解密载荷；密码不对（或数据被改坏）一律给「密码错误」
 * @param {Uint8Array} data
 * @param {string} password
 * @returns {Uint8Array}
 */
export function decryptPayload(data, password) {
  if (data.length < IV_LENGTH + TAG_LENGTH + 1) throw new Error('密码错误');
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(data.length - TAG_LENGTH);
  const body = data.subarray(IV_LENGTH, data.length - TAG_LENGTH);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(password), iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(Buffer.from(tag));
    return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(body)), decipher.final()]));
  } catch {
    throw new Error('密码错误');
  }
}