// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * Passwords and tokens.
 *
 * Nothing clever here on purpose. scrypt from the standard library, a random
 * salt per user, and a constant-time comparison - which are the three things
 * that are actually load-bearing, and all three are easy to get subtly wrong by
 * reaching for something more interesting.
 */

import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

// promisify picks the 3-argument overload, so the options form needs its own
// signature. The cost parameters below are the entire point of using scrypt.
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>

/**
 * Deliberately expensive. These are the OWASP-suggested scrypt parameters and
 * they cost roughly 100ms per hash, which is the point: it makes an offline
 * attack on a stolen database slow, at a price a login can afford to pay once.
 */
// maxmem has to be raised deliberately: scrypt needs about 128 * N * r bytes,
// which is 128 MB at these parameters, and Node refuses above 32 MB by default.
// Without it every hash throws, and it throws at signup rather than at boot.
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keylen: 64, maxmem: 192 * 1024 * 1024 }

export function newSalt(): string {
  return randomBytes(16).toString('hex')
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const derived = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT)
  return derived.toString('hex')
}

export async function verifyPassword(
  password: string,
  salt: string,
  expected: string
): Promise<boolean> {
  const derived = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT)
  const target = Buffer.from(expected, 'hex')
  // Lengths must match before timingSafeEqual will look at the contents, and a
  // mismatch there is itself an answer - but only about the stored format, not
  // about the password, so returning early is safe.
  if (derived.length !== target.length) return false
  return timingSafeEqual(derived, target)
}

/** 256 bits from the CSPRNG. Not a JWT: revoking one should be a DELETE. */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function newId(): string {
  return randomUUID()
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value)
}

/**
 * Length is the only rule.
 *
 * Composition rules - a digit, a symbol, a capital - measurably push people
 * towards `Password1!` and are no longer recommended by anyone who has looked
 * at the data. A minimum length and a maximum that stops someone posting a
 * megabyte into scrypt is the whole policy.
 */
export function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 10 && value.length <= 512
}
