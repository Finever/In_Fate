export interface SchemaIssue {
  readonly path: string
  readonly message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateValue(schema: unknown, value: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = []
  check(schema, value, '$', issues)
  return issues
}

function check(schema: unknown, value: unknown, path: string, issues: SchemaIssue[]): void {
  if (!isRecord(schema)) return

  const expected = schema.type
  if (typeof expected === 'string') {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
    const ok =
      expected === actual ||
      (expected === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
      (expected === 'number' && typeof value === 'number')
    if (!ok) {
      issues.push({ path, message: `expected ${expected}, got ${actual}` })
      return
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    issues.push({ path, message: `not one of ${JSON.stringify(schema.enum)}` })
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      issues.push({ path, message: `shorter than ${schema.minLength}` })
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      issues.push({ path, message: `longer than ${schema.maxLength}` })
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      issues.push({ path, message: `less than ${schema.minimum}` })
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      issues.push({ path, message: `greater than ${schema.maximum}` })
    }
  }

  if (Array.isArray(value)) {
    if (schema.items !== undefined) {
      value.forEach((item, index) => check(schema.items, item, `${path}[${index}]`, issues))
    }
    return
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof key === 'string' && !(key in value)) {
        issues.push({ path: `${path}.${key}`, message: 'missing required property' })
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) {
        check(properties[key], child, `${path}.${key}`, issues)
      } else if (schema.additionalProperties === false) {
        issues.push({ path: `${path}.${key}`, message: 'unexpected property' })
      }
    }
  }
}
