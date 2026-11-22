/**
 * 按需注册的 ECharts：只打进用到的图表与组件，其余走 tree-shaking。
 * 这个模块只应通过动态 import 进入（见 EChart.tsx），保证首屏不带图表代码。
 */
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
])

export { echarts }
