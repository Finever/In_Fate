export interface Point {
  x: number
  y: number
}

export interface LayoutLink {
  from: string
  to: string
}

/** 小型确定性力导向：几十个节点足够，不引入 d3。 */
export function layoutConstellation(
  ids: readonly string[],
  links: readonly LayoutLink[],
  width: number,
  height: number,
): Map<string, Point> {
  const points = new Map<string, Point>()
  const count = ids.length
  if (count === 0) return points
  if (width <= 0 || height <= 0) {
    ids.forEach((id, index) => points.set(id, { x: index * 10, y: index * 10 }))
    return points
  }

  const cx = width / 2
  const cy = height / 2
  const radius = Math.min(width, height) * 0.33
  ids.forEach((id, index) => {
    const angle = (Math.PI * 2 * index) / count - Math.PI / 2
    points.set(id, {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    })
  })

  const ideal = Math.sqrt((width * height) / Math.max(1, count)) * 0.44
  const hole = Math.min(width, height) * 0.17
  const velocity = new Map<string, Point>(ids.map(id => [id, { x: 0, y: 0 }]))

  for (let iteration = 0; iteration < 150; iteration += 1) {
    const cooling = 1 - iteration / 170

    for (let i = 0; i < count; i += 1) {
      const aId = ids[i]!
      const a = points.get(aId)!
      for (let j = i + 1; j < count; j += 1) {
        const bId = ids[j]!
        const b = points.get(bId)!
        let dx = a.x - b.x
        let dy = a.y - b.y
        let distance = Math.hypot(dx, dy)
        if (distance < 0.01) {
          dx = ((i + 1) % 7) - 3
          dy = ((j + 1) % 7) - 3
          distance = Math.hypot(dx, dy) || 1
        }
        const force = (ideal * ideal) / distance
        const fx = (dx / distance) * force
        const fy = (dy / distance) * force
        const av = velocity.get(aId)!
        const bv = velocity.get(bId)!
        av.x += fx
        av.y += fy
        bv.x -= fx
        bv.y -= fy
      }
    }

    for (const link of links) {
      const a = points.get(link.from)
      const b = points.get(link.to)
      if (!a || !b) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const distance = Math.hypot(dx, dy) || 1
      const force = (distance - ideal * 1.4) * 0.1
      const fx = (dx / distance) * force
      const fy = (dy / distance) * force
      const av = velocity.get(link.from)!
      const bv = velocity.get(link.to)!
      av.x += fx
      av.y += fy
      bv.x -= fx
      bv.y -= fy
    }

    for (const id of ids) {
      const point = points.get(id)!
      const v = velocity.get(id)!
      v.x += (cx - point.x) * 0.005
      v.y += (cy - point.y) * 0.005
      v.x *= 0.84
      v.y *= 0.84
      const maxStep = 24 * cooling
      const step = Math.hypot(v.x, v.y)
      if (step > maxStep) {
        v.x = (v.x / step) * maxStep
        v.y = (v.y / step) * maxStep
      }
      point.x = Math.max(90, Math.min(width - 90, point.x + v.x))
      point.y = Math.max(80, Math.min(height - 80, point.y + v.y))

      // 给中央的标题留一个空洞，避免节点压在品牌字上。
      const dx = point.x - cx
      const dy = point.y - cy
      const distance = Math.hypot(dx, dy)
      if (distance > 0 && distance < hole) {
        const push = (hole - distance) * 0.55
        point.x += (dx / distance) * push
        point.y += (dy / distance) * push
      }
    }
  }

  return points
}

export function linkCurve(from: Point, to: Point, index: number): string {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy) || 1
  const bend = (index % 2 === 0 ? 1 : -1) * Math.min(38, distance * 0.16)
  const mx = (from.x + to.x) / 2
  const my = (from.y + to.y) / 2
  const cx = mx - (dy / distance) * bend
  const cy = my + (dx / distance) * bend
  return `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`
}
