import { useEffect, useRef } from 'react'
import type { EChartsCoreOption, EChartsType } from 'echarts/core'

interface EChartProps {
  /** ECharts option；这里不做类型收窄，图表代码按需加载。 */
  option: object
  height?: number
  className?: string
}

/** ECharts 懒加载包装：第一次真正渲染时才把 echarts 拉进来，卸载即释放。 */
export function EChart({ option, height = 260, className }: EChartProps) {
  const host = useRef<HTMLDivElement | null>(null)
  const chart = useRef<EChartsType | null>(null)
  const latest = useRef<object>(option)
  latest.current = option

  useEffect(() => {
    let cancelled = false
    let observer: ResizeObserver | undefined
    void import('../lib/echarts').then(({ echarts }) => {
      if (cancelled || !host.current) return
      const instance = echarts.init(host.current, undefined, { renderer: 'canvas' })
      chart.current = instance
      instance.setOption(latest.current as EChartsCoreOption)
      observer = new ResizeObserver(() => instance.resize())
      observer.observe(host.current)
    })
    return () => {
      cancelled = true
      observer?.disconnect()
      chart.current?.dispose()
      chart.current = null
    }
  }, [])

  useEffect(() => {
    chart.current?.setOption(option as EChartsCoreOption, true)
  }, [option])

  return <div ref={host} className={className} style={{ width: '100%', height }} />
}
