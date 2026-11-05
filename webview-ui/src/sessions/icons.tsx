/** Small inline icons (no codicon font in the webview). 16×16, currentColor. */
const box = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true } as const;
const stroke = { stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg {...box} className={`chev${open ? ' open' : ''}`}>
    <path d="M6 4l4 4-4 4" {...stroke} />
  </svg>
);
export const PlusIcon = () => (
  <svg {...box}>
    <path d="M8 3v10M3 8h10" {...stroke} />
  </svg>
);
export const SearchIcon = () => (
  <svg {...box}>
    <circle cx="7" cy="7" r="4" {...stroke} />
    <path d="M10 10l3.5 3.5" {...stroke} />
  </svg>
);
export const BoltIcon = () => (
  <svg {...box}>
    <path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z" fill="currentColor" />
  </svg>
);
export const FilterIcon = () => (
  <svg {...box}>
    <path d="M2 3h12L9.5 8.5V13l-3-1.5v-3z" fill="currentColor" />
  </svg>
);
export const TrashIcon = () => (
  <svg {...box}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" {...stroke} />
  </svg>
);
export const CloseIcon = () => (
  <svg {...box}>
    <path d="M4 4l8 8M12 4l-8 8" {...stroke} />
  </svg>
);
export const WarnIcon = () => (
  <svg {...box}>
    <path d="M8 2l6.5 11.5h-13z" {...stroke} />
    <path d="M8 6.5v3.2M8 11.6v.1" {...stroke} />
  </svg>
);
export const ClockIcon = () => (
  <svg {...box}>
    <circle cx="8" cy="8" r="5.5" {...stroke} />
    <path d="M8 5v3.2l2 1.3" {...stroke} />
  </svg>
);
