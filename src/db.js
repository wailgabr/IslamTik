import initSqlJs from 'sql.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, '..', 'islamtok.db')

let SQL = null
let _db = null

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this._params = [] }
  bind(...params) { this._params = params.flat(); return this }
  run(...params) {
    const p = params.length ? params : this._params
    try { this.db.db.run(this.sql, p); this.db._save() } catch(e) { this.db._save() }
    return { lastInsertRowid: this.db._lastId() }
  }
  get(...params) {
    const p = params.length ? params : this._params
    const stmt = this.db.db.prepare(this.sql)
    if (p.length) stmt.bind(p)
    if (stmt.step()) { const r = stmt.getAsObject(); stmt.free(); return r }
    stmt.free(); return undefined
  }
  all(...params) {
    const p = params.length ? params : this._params
    const stmt = this.db.db.prepare(this.sql)
    if (p.length) stmt.bind(p)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free(); return rows
  }
}

class Database {
  constructor(dbPath) {
    this.path = dbPath || DB_PATH
  }
  async init() {
    if (_db) { this.db = _db; return }
    SQL = SQL || await initSqlJs()
    try {
      const buf = fs.readFileSync(this.path)
      _db = this.db = new SQL.Database(buf)
    } catch {
      _db = this.db = new SQL.Database()
    }
    this.db.run('PRAGMA journal_mode=WAL')
    this.db.run('PRAGMA foreign_keys=ON')
  }
  _save() {
    try {
      const data = this.db.export()
      fs.writeFileSync(this.path, Buffer.from(data))
    } catch {}
  }
  _lastId() {
    try { return Number(this.db.exec("SELECT last_insert_rowid() as id")[0]?.values?.[0]?.[0]) || 0 } catch { return 0 }
  }
  prepare(sql) { return new Statement(this, sql) }
  exec(sql) { this.db.run(sql); this._save() }
  pragma(sql) { this.db.run(sql) }
  close() { this._save() }
}

let instance = null
export async function getDB(dbPath) {
  if (instance) return instance
  instance = new Database(dbPath)
  await instance.init()
  return instance
}
