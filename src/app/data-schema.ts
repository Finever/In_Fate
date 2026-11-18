/**
 * 数据 schema 版本与迁移骨架。
 *
 * 这里只负责“数据根能不能被当前版本打开”：
 *   - 第一次运行写入版本；
 *   - 旧版本按迁移链升级；
 *   - 新版本拒绝降级打开；
 *   - 迁移前把 schema 状态备份到 .state/backups。
 *
 * 具体迁移函数以后往 DATA_MIGRATIONS 里加；没有注册迁移时不允许硬升。
 *
 * @module if/app/data-schema
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const DATA_SCHEMA_VERSION = 1

export interface DataSchemaState {
  readonly version: number
  readonly appVersion: string
  readonly updatedAt: string
}

export interface DataMigration {
  readonly from: number
  readonly to: number
  readonly name: string
  run(dataRoot: string): void | Promise<void>
}

/** 迁移链；空数组表示当前没有已发布的数据迁移。 */
export const DATA_MIGRATIONS: readonly DataMigration[] = []

export class DataSchemaError extends Error {
  readonly code = 'data_schema' as const

  constructor(message: string) {
    super(message)
    this.name = 'DataSchemaError'
  }
}

export interface EnsureDataSchemaOptions {
  readonly now?: () => Date
  readonly migrations?: readonly DataMigration[]
  readonly targetVersion?: number
}

function statePath(dataRoot: string): string {
  return join(dataRoot, '.state', 'data-schema.json')
}

function readState(file: string): DataSchemaState {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new DataSchemaError(`data schema file is unreadable: ${file}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DataSchemaError(`invalid data schema file: ${file}`)
  }
  const record = raw as { version?: unknown; appVersion?: unknown; updatedAt?: unknown }
  if (typeof record.version !== 'number' || !Number.isInteger(record.version) || record.version < 0) {
    throw new DataSchemaError(`invalid data schema version: ${file}`)
  }
  return {
    version: record.version,
    appVersion: typeof record.appVersion === 'string' ? record.appVersion : 'unknown',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
  }
}

function writeState(dataRoot: string, state: DataSchemaState): void {
  const file = statePath(dataRoot)
  mkdirSync(join(dataRoot, '.state'), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

function backupState(dataRoot: string, state: DataSchemaState): string {
  const dir = join(dataRoot, '.state', 'backups')
  mkdirSync(dir, { recursive: true })
  const target = join(
    dir,
    `data-schema-v${state.version}-${Date.now()}.json`,
  )
  copyFileSync(statePath(dataRoot), target)
  return target
}

/**
 * 打开数据根前调用。第一次运行会创建状态文件；已存在则校验并迁移。
 */
export async function ensureDataSchema(
  dataRoot: string,
  appVersion: string,
  options: EnsureDataSchemaOptions = {},
): Promise<DataSchemaState> {
  const targetVersion = options.targetVersion ?? DATA_SCHEMA_VERSION
  const migrations = options.migrations ?? DATA_MIGRATIONS
  const now = options.now ?? (() => new Date())
  const file = statePath(dataRoot)

  if (!existsSync(file)) {
    const state: DataSchemaState = {
      version: targetVersion,
      appVersion,
      updatedAt: now().toISOString(),
    }
    writeState(dataRoot, state)
    return state
  }

  let state = readState(file)
  if (state.version > targetVersion) {
    throw new DataSchemaError(
      `data schema v${state.version} is newer than app schema v${targetVersion}; refusing to downgrade`,
    )
  }

  if (state.version < targetVersion) {
    backupState(dataRoot, state)
    while (state.version < targetVersion) {
      const migration = migrations.find(item => item.from === state.version)
      if (!migration) {
        throw new DataSchemaError(
          `data schema v${state.version} needs migration to v${targetVersion}, but no migration is registered`,
        )
      }
      if (migration.to <= migration.from || migration.to > targetVersion) {
        throw new DataSchemaError(`invalid migration ${migration.name}: v${migration.from} -> v${migration.to}`)
      }
      await migration.run(dataRoot)
      state = {
        version: migration.to,
        appVersion,
        updatedAt: now().toISOString(),
      }
      writeState(dataRoot, state)
    }
  }

  if (state.appVersion !== appVersion) {
    state = {
      version: state.version,
      appVersion,
      updatedAt: now().toISOString(),
    }
    writeState(dataRoot, state)
  }
  return state
}
