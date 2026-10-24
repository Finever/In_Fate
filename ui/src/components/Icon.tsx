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
  | 'layers'
  | 'tool'

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
  archive: ['M4 7h16', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3', 'M10 11v5', 'M14 11v5'],
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
  layers: ['M12 3l9 5-9 5-9-5 9-5Z', 'M3 13l9 5 9-5', 'M3 17l9 5 9-5'],
  tool: ['M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.7 2.7-2-2 2.7-2.7Z'],
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
