import type { SVGProps } from 'react'

export type IconName =
  | 'chat'
  | 'graph'
  | 'agents'
  | 'approvals'
  | 'plus'
  | 'search'
  | 'refresh'
  | 'archive'
  | 'trash'
  | 'close'
  | 'link'
  | 'chevron'
  | 'send'
  | 'panel'
  | 'info'
  | 'warning'
  | 'check'
  | 'clock'
  | 'fullscreen'
  | 'minimize'
  | 'settings'
  | 'layers'
  | 'tool'
  | 'sidebar'
  | 'more'
  | 'down'
  | 'filter'
  | 'pin'
  | 'chart'

const PATHS: Record<IconName, string[]> = {
  chat: [
    'M5 5.5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-8l-4.5 3v-3H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z',
    'M8 9.5h8',
    'M8 13h5',
  ],
  graph: [
    'M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
    'M18 13.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
    'M8 21.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
    'M8 7.5v9',
    'M8.5 8.5l7 3',
  ],
  agents: [
    'M12 3l7 4v5c0 4.2-2.9 7.3-7 9-4.1-1.7-7-4.8-7-9V7l7-4Z',
    'M9.5 11.5h5',
    'M9.5 14.5h3',
  ],
  approvals: [
    'M12 3l7 4v5c0 4.2-2.9 7.3-7 9-4.1-1.7-7-4.8-7-9V7l7-4Z',
    'M9 12l2 2 4-4',
  ],
  plus: ['M12 5v14', 'M5 12h14'],
  search: ['M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z', 'M16 16l4.5 4.5'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 5v6h-6'],
  archive: [
    'M3 4h18v4H3V4Z',
    'M4.5 8h15v12h-15V8Z',
    'M9.5 12h5',
  ],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v5', 'M14 11v5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  link: [
    'M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1.3 1.3',
    'M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1.3-1.3',
  ],
  chevron: ['M9 6l6 6-6 6'],
  send: ['M4 12L20 4l-4 16-4-6-8-2Z', 'M12 14l8-10'],
  panel: ['M4 4h16v16H4z', 'M14 4v16'],
  info: ['M12 8h.01', 'M12 11v5', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z'],
  warning: ['M12 4L2.8 20h18.4L12 4Z', 'M12 9v5', 'M12 17h.01'],
  check: ['M5 12l4 4L19 6'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 2'],
  fullscreen: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
  minimize: ['M5 12h14'],
  settings: [
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z',
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  ],
  layers: ['M12 3l9 5-9 5-9-5 9-5Z', 'M3 13l9 5 9-5', 'M3 17l9 5 9-5'],
  tool: ['M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.7 2.7-2-2 2.7-2.7Z'],
  sidebar: ['M4 4h16v16H4z', 'M9 4v16'],
  more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
  down: ['M6 9l6 6 6-6'],
  filter: ['M4 6h16', 'M7 12h10', 'M10 18h4'],
  pin: ['M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5Z', 'M12 14v6'],
  chart: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M3 20h18'],
}

export function Icon({
  name,
  size = 18,
  ...props
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {PATHS[name].map((path, index) => <path key={index} d={path} />)}
    </svg>
  )
}
