'use strict';

/**
 * Хеширование паролей.
 *
 * Основной алгоритм — bcrypt (cost 12), как и требует ТЗ. Модуль bcrypt нативный:
 * если в конкретном окружении он не собрался (например, нет доступа к prebuilt-бинарнику
 * или компилятора), npm не падает, а приложение автоматически использует встроенный
 * в Node.js scrypt (N=16384, r=8, p=1, keylen=64) — тоже стойкий алгоритм с солью.
 *
 * Форматы хешей различаются префиксом, поэтому проверка работает с обоими:
 *   bcrypt → $2b$12$...
 *   scrypt → scrypt$N$r$p$<salt-base64>$<hash-base64>
 */

const crypto = require('crypto');

let bcrypt = null;
try {
  // eslint-disable-next-line global-require
  bcrypt = require('bcrypt');
} catch {
  bcrypt = null;
}

const BCRYPT_ROUNDS = 12;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const SCRYPT_PREFIX = 'scrypt';

const algorithm = bcrypt ? 'bcrypt' : 'scrypt';

/* ------------------------------ scrypt ---------------------------------- */

function scryptHash(plain) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(plain, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_PARAMS.maxmem,
  });
  return [
    SCRYPT_PREFIX,
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

function scryptVerify(plain, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== SCRYPT_PREFIX) return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = crypto.scryptSync(plain, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT_PARAMS.maxmem,
    });
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

const isBcryptHash = (hash) => typeof hash === 'string' && /^\$2[abxy]?\$/.test(hash);
const isScryptHash = (hash) => typeof hash === 'string' && hash.startsWith(`${SCRYPT_PREFIX}$`);

/* ------------------------------- Публичное API --------------------------- */

async function hashPassword(plain) {
  const value = String(plain ?? '');
  if (bcrypt) return bcrypt.hash(value, BCRYPT_ROUNDS);
  return scryptHash(value);
}

function hashPasswordSync(plain) {
  const value = String(plain ?? '');
  if (bcrypt) return bcrypt.hashSync(value, BCRYPT_ROUNDS);
  return scryptHash(value);
}

async function verifyPassword(plain, stored) {
  const password = String(plain ?? '');
  if (!stored) return false;
  if (isBcryptHash(stored)) {
    if (!bcrypt) return false; // хеш создан там, где bcrypt был доступен
    try {
      return await bcrypt.compare(password, stored);
    } catch {
      return false;
    }
  }
  if (isScryptHash(stored)) return scryptVerify(password, stored);
  return false;
}

function verifyPasswordSync(plain, stored) {
  const password = String(plain ?? '');
  if (!stored) return false;
  if (isBcryptHash(stored)) {
    if (!bcrypt) return false;
    try {
      return bcrypt.compareSync(password, stored);
    } catch {
      return false;
    }
  }
  if (isScryptHash(stored)) return scryptVerify(password, stored);
  return false;
}

/** Время «холостой» проверки, чтобы нельзя было определить существование логина. */
async function dummyVerify() {
  await hashPassword('timing-equalizer-placeholder');
}

/** Генерация читаемого и стойкого пароля: 4 блока по 5 символов. */
function generatePassword() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out.match(/.{1,5}/g).join('-');
}

module.exports = {
  algorithm,
  hashPassword,
  hashPasswordSync,
  verifyPassword,
  verifyPasswordSync,
  generatePassword,
  dummyVerify,
  isBcryptHash,
  isScryptHash,
  BCRYPT_ROUNDS,
};
