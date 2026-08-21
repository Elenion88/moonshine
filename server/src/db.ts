// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * Storage. SQLite, from Node's own standard library.
 *
 * The whole point of this service is to be the smallest thing that can answer
 * "which machines are mine, and where are they right now" - so it has no
 * dependencies at all. `node:sqlite` ships with Node, which means no native
 * build step, no ORM, and no migration framework for four tables.
 *
 * It is still marked experimental by Node, which is the one caveat worth
 * knowing: the API could change under a major version. That is a smaller risk
 * than a dependency tree, and the surface used here is about six calls wide.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface User {
  id: string
  email: string
  password_hash: string
  salt: string
  created_at: number
}

export interface Device {
  id: string
  user_id: string
  name: string
  os: string
  created_at: number
  last_seen: number
  observed_ip: string | null
  endpoints: string
  public_key: string | null
}

export interface Endpoint {
  /** `local` is an address the device sees on its own interfaces. */
  kind: 'local' | 'observed' | 'manual'
  address: string
  port: number
}

let db: DatabaseSync

export function open(path: string): void {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  db = new DatabaseSync(path)

  // WAL so a read during a write does not block. This service is
  // read-mostly - every device asks for the peer list far more often than it
  // changes anything.
  db.exec('pragma journal_mode = WAL')
  db.exec('pragma foreign_keys = ON')

  db.exec(`
    create table if not exists users (
      id            text primary key,
      email         text not null unique,
      password_hash text not null,
      salt          text not null,
      created_at    integer not null
    );

    create table if not exists tokens (
      token      text primary key,
      user_id    text not null references users(id) on delete cascade,
      created_at integer not null,
      last_seen  integer not null
    );

    create table if not exists devices (
      id          text primary key,
      user_id     text not null references users(id) on delete cascade,
      name        text not null,
      os          text not null default '',
      created_at  integer not null,
      last_seen   integer not null,
      observed_ip text,
      endpoints   text not null default '[]',
      public_key  text
    );

    create index if not exists devices_by_user on devices(user_id);
    create index if not exists tokens_by_user on tokens(user_id);
  `)
}

export function close(): void {
  db?.close()
}

// -- users -------------------------------------------------------------------

export function createUser(user: Omit<User, 'created_at'>): void {
  db.prepare(
    'insert into users (id, email, password_hash, salt, created_at) values (?, ?, ?, ?, ?)'
  ).run(user.id, user.email, user.password_hash, user.salt, Date.now())
}

export function findUserByEmail(email: string): User | undefined {
  return db.prepare('select * from users where email = ?').get(email) as
    | unknown as User
    | undefined
}

// -- tokens ------------------------------------------------------------------

export function createToken(token: string, userId: string): void {
  const now = Date.now()
  db.prepare('insert into tokens (token, user_id, created_at, last_seen) values (?, ?, ?, ?)').run(
    token,
    userId,
    now,
    now
  )
}

export function userForToken(token: string): string | null {
  const row = db.prepare('select user_id from tokens where token = ?').get(token) as
    | { user_id: string }
    | undefined
  if (!row) return null
  db.prepare('update tokens set last_seen = ? where token = ?').run(Date.now(), token)
  return row.user_id
}

export function deleteToken(token: string): void {
  db.prepare('delete from tokens where token = ?').run(token)
}

// -- devices -----------------------------------------------------------------

export function upsertDevice(device: {
  id: string
  userId: string
  name: string
  os: string
  publicKey: string | null
}): void {
  const now = Date.now()
  db.prepare(
    `insert into devices (id, user_id, name, os, created_at, last_seen, public_key)
     values (?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set
       name = excluded.name,
       os = excluded.os,
       last_seen = excluded.last_seen,
       -- A device that omits its key keeps the one it had, so an older client
       -- upgrading does not wipe what a newer one published.
       public_key = coalesce(excluded.public_key, devices.public_key)`
  ).run(device.id, device.userId, device.name, device.os, now, now, device.publicKey)
}

/**
 * Add the column to a database created before keys existed.
 *
 * Four tables do not need a migration framework, but they do need this: a
 * `create table if not exists` silently does nothing when the table is already
 * there, so an existing install would never gain the column.
 */
export function migrate(): void {
  const columns = db.prepare('pragma table_info(devices)').all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'public_key')) {
    db.exec('alter table devices add column public_key text')
  }
}

export function touchDevice(
  id: string,
  userId: string,
  observedIp: string | null,
  endpoints: Endpoint[]
): boolean {
  const result = db
    .prepare(
      'update devices set last_seen = ?, observed_ip = ?, endpoints = ? where id = ? and user_id = ?'
    )
    .run(Date.now(), observedIp, JSON.stringify(endpoints), id, userId)
  return result.changes > 0
}

export function devicesForUser(userId: string): Device[] {
  // node:sqlite types rows as Record<string, SQLOutputValue>, which is honest -
  // it cannot know the schema. The cast through unknown is where that promise
  // is made, and the schema above is what backs it.
  return db
    .prepare('select * from devices where user_id = ? order by name')
    .all(userId) as unknown as Device[]
}

export function deleteDevice(id: string, userId: string): boolean {
  const result = db.prepare('delete from devices where id = ? and user_id = ?').run(id, userId)
  return result.changes > 0
}
