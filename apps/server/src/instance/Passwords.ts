// @effect-diagnostics nodeBuiltinImport:off -- Effect's Crypto has no scrypt or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";

// OWASP's scrypt baseline (N=2^17, r=8, p=1) needs 128 MiB; this keeps memory per login bounded.
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const scrypt = (password: string, salt: Buffer, params: { n: number; r: number; p: number }) =>
  Effect.callback<Buffer, Error>((resume) => {
    NodeCrypto.scrypt(
      password.normalize("NFKC"),
      salt,
      KEY_LENGTH,
      { N: params.n, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
      (error, key) => resume(error ? Effect.fail(error) : Effect.succeed(key)),
    );
  });

/** `scrypt$N$r$p$salt$hash`, base64url fields. */
export const hashPassword = Effect.fn("Passwords.hash")(function* (password: string) {
  const salt = NodeCrypto.randomBytes(16);
  const key = yield* scrypt(password, salt, { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
});

export const verifyPassword = Effect.fn("Passwords.verify")(function* (
  password: string,
  encoded: string,
) {
  const [scheme, n, r, p, salt, hash] = encoded.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = yield* scrypt(password, Buffer.from(salt, "base64url"), {
    n: Number(n),
    r: Number(r),
    p: Number(p),
  }).pipe(Effect.orElseSucceed(() => Buffer.alloc(0)));
  return actual.length === expected.length && NodeCrypto.timingSafeEqual(actual, expected);
});

/** A hash nobody's password matches, so unknown emails cost the same as wrong passwords. */
export const DUMMY_PASSWORD_HASH = `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(KEY_LENGTH).toString("base64url")}`;

// No 0/O/1/l/I so temporary passwords survive being read aloud or retyped.
const TEMPORARY_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const generateTemporaryPassword = () => {
  const groups: Array<string> = [];
  for (let group = 0; group < 4; group += 1) {
    let chunk = "";
    for (let index = 0; index < 4; index += 1) {
      chunk += TEMPORARY_ALPHABET[NodeCrypto.randomInt(TEMPORARY_ALPHABET.length)];
    }
    groups.push(chunk);
  }
  return groups.join("-");
};

export const generateSecret = () => NodeCrypto.randomBytes(32).toString("base64url");

export const sha256 = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("base64url");

export const timingSafeEqualStrings = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
};
