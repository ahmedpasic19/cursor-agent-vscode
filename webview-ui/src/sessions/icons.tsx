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
export const ArrowUpIcon = () => (
  <svg {...box}>
    <path d="M8 13V3.5M4 7.5L8 3.5l4 4" {...stroke} strokeWidth={1.6} />
  </svg>
);
export const StopIcon = () => (
  <svg {...box}>
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" />
  </svg>
);
export const CheckIcon = () => (
  <svg {...box}>
    <path d="M3.5 8.5l3 3 6-7" {...stroke} />
  </svg>
);
/** Agent mode: </> */
export const CodeIcon = () => (
  <svg {...box}>
    <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 3L7 13" {...stroke} />
  </svg>
);
/** Ask mode: speech bubble */
export const ChatIcon = () => (
  <svg {...box}>
    <path d="M2.5 3.5h11v7.5H7l-3 2.5v-2.5H2.5z" {...stroke} />
  </svg>
);
/** Plan mode: checklist */
export const PlanIcon = () => (
  <svg {...box}>
    <path d="M2.5 4l1 1 2-2M2.5 9l1 1 2-2M7.5 4.2h6M7.5 9.2h6M7.5 13h6" {...stroke} />
  </svg>
);
export const SlashIcon = () => (
  <svg {...box}>
    <rect x="2" y="2" width="12" height="12" rx="2.5" {...stroke} />
    <path d="M9.6 4.8L6.4 11.2" {...stroke} />
  </svg>
);
export const BranchIcon = () => (
  <svg {...box}>
    <circle cx="4.5" cy="3.5" r="1.5" {...stroke} />
    <circle cx="4.5" cy="12.5" r="1.5" {...stroke} />
    <circle cx="11.5" cy="5.5" r="1.5" {...stroke} />
    <path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-7 4" {...stroke} />
  </svg>
);
export const FileIcon = () => (
  <svg {...box}>
    <path d="M4 1.8h5l3 3v9.4H4z M9 1.8v3h3" {...stroke} />
  </svg>
);
export const RefreshIcon = () => (
  <svg {...box}>
    <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" {...stroke} />
  </svg>
);
export const RestoreIcon = () => (
  <svg {...box}>
    <path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3" {...stroke} />
  </svg>
);
export const GearIcon = () => (
  <svg {...box}>
    <circle cx="8" cy="8" r="2" {...stroke} />
    <path
      d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7L3.6 3.6"
      {...stroke}
    />
  </svg>
);
