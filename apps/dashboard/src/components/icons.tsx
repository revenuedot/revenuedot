import type { ReactNode } from "react";

const P: Record<string, ReactNode> = {
  overview: <><rect x="2" y="2" width="5" height="5" /><rect x="9" y="2" width="5" height="5" /><rect x="2" y="9" width="5" height="5" /><rect x="9" y="9" width="5" height="5" /></>,
  analytics: <path d="M2 13.5h12M4.5 11V8M8 11V4.5M11.5 11V6.5" />,
  customers: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3 14c.7-2.4 2.7-3.8 5-3.8s4.3 1.4 5 3.8" /></>,
  catalog: <path d="M2 5l6-3 6 3-6 3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3" />,
  paywalls: <><rect x="4" y="1.5" width="8" height="13" /><path d="M6.5 11.5h3" /></>,
  targeting: <><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="2.5" /></>,
  experiments: <path d="M6 2v4.5L2.5 13a1 1 0 00.9 1.5h9.2a1 1 0 00.9-1.5L10 6.5V2M5 2h6" />,
  funnels: <path d="M2 3h12l-4.5 5.5V13l-3 1.5v-6z" />,
  ads: <path d="M2.5 6.5v3h2l4 3v-9l-4 3zM11 5.5a3.5 3.5 0 010 5" />,
  lifecycle: <path d="M13.5 8A5.5 5.5 0 113 5.2M3 2v3.2h3.2" />,
  auth: <path d="M8 1.5l5 2v4c0 3.2-2.2 5.6-5 7-2.8-1.4-5-3.8-5-7v-4z" />,
  apps: <><rect x="2" y="2" width="5" height="5" /><rect x="9" y="2" width="5" height="5" /><rect x="2" y="9" width="5" height="5" /><path d="M11.5 9v5M9 11.5h5" /></>,
  web: <><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" /></>,
  key: <><circle cx="5.5" cy="8" r="3" /><path d="M8.5 8h6M12.5 8v2.5" /></>,
  integrations: <><path d="M6 3H3v3M10 3h3v3M6 13H3v-3M10 13h3v-3" /><rect x="6" y="6" width="4" height="4" /></>,
  settings: <><circle cx="8" cy="8" r="2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></>,
  chev: <path d="M6 4l4 4-4 4" />,
  updown: <path d="M5 6l3-3 3 3M5 10l3 3 3-3" />,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></>,
  docs: <><path d="M3 2.5h7l3 3v8H3z" /><path d="M10 2.5v3h3" /></>,
  bell: <path d="M4 11V7a4 4 0 118 0v4l1 1.5H3zM6.5 14h3" />,
  moon: <path d="M13 9.5A5.5 5.5 0 016.5 3 5.5 5.5 0 1013 9.5z" />,
  spark: <path d="M8 2l1.3 3.2L12.5 6.5 9.3 7.8 8 11 6.7 7.8 3.5 6.5 6.7 5.2z" />,
  plus: <path d="M8 3v10M3 8h10" />,
  copy: <><rect x="5" y="5" width="8.5" height="8.5" /><path d="M3 10.5V2.5h8" /></>,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  menu: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9" />,
  logout: <path d="M6 3H3v10h3M10 5l3 3-3 3M13 8H6.5" />,
  arrow: <path d="M3 8h10M9 4l4 4-4 4" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  dollar: <path d="M8 2v12M11 4.5H6.5a2 2 0 000 4h3a2 2 0 010 4H5" />,
  hourglass: <path d="M5 2h6M5 14h6M6 2c0 4 4 4 4 6s-4 2-4 6M10 2c0 4-4 4-4 6" />,
  box: <><rect x="2.5" y="3.5" width="11" height="10" /><path d="M2.5 6.5h11" /></>,
  userplus: <><circle cx="7" cy="5.5" r="2.5" /><path d="M2 14c.7-2.4 2.7-3.8 5-3.8M12 9v5M9.5 11.5h5" /></>,
  refresh: <path d="M13.5 8A5.5 5.5 0 113 5.2M3 2v3.2h3.2" />,
  more: <><circle cx="3.5" cy="8" r=".6" /><circle cx="8" cy="8" r=".6" /><circle cx="12.5" cy="8" r=".6" /></>,
  grip: <><circle cx="6" cy="4" r=".5" /><circle cx="10" cy="4" r=".5" /><circle cx="6" cy="8" r=".5" /><circle cx="10" cy="8" r=".5" /><circle cx="6" cy="12" r=".5" /><circle cx="10" cy="12" r=".5" /></>,
  edit: <path d="M10.5 2.5l3 3L6 13H3v-3z" />,
  archive: <><rect x="2" y="3" width="12" height="3" /><path d="M3 6v7.5h10V6M6.5 9h3" /></>,
  link: <path d="M7 9a2.5 2.5 0 003.5 0l2.5-2.5a2.5 2.5 0 00-3.5-3.5L8.8 3.7M9 7a2.5 2.5 0 00-3.5 0L3 9.5A2.5 2.5 0 006.5 13l.7-.7" />,
  duplicate: <><rect x="5" y="5" width="8.5" height="8.5" /><path d="M3 10.5V2.5h8M9.25 7.5v4M7.25 9.5h4" /></>,
  up: <path d="M4 10l4-4 4 4" />,
  down: <path d="M4 6l4 4 4-4" />,
  eye: <><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>,
  eyeoff: <><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><path d="M2.5 2.5l11 11" /></>,
  send: <path d="M14 2L7 9M14 2l-4.5 12L7 9 2 6.5z" />,
  apple: <path d="M10.5 1.5c0 1.4-1.1 2.6-2.4 2.6 0-1.4 1.1-2.6 2.4-2.6zM12.9 11c-.5 1.2-1.3 2.7-2.4 2.7-.9 0-1.1-.6-2.3-.6s-1.5.6-2.3.6c-1.1 0-2.2-1.8-2.7-3.2-.8-2.3-.3-5 1.9-5.3.9-.1 1.7.6 2.2.6s1.4-.7 2.5-.6c.5 0 1.9.2 2.6 1.4-2.1 1.2-1.7 4 .5 4.4z" />,
  play: <path d="M3.5 2l9.5 6-9.5 6z" />,
  flask: <path d="M6 2v4.5L2.5 13a1 1 0 00.9 1.5h9.2a1 1 0 00.9-1.5L10 6.5V2M5 2h6M4.5 10h7" />,
};

export function Icon({ name, className = "i", title }: { name: keyof typeof P | string; className?: string; title?: string }) {
  return <svg className={className} viewBox="0 0 16 16" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>{title ? <title>{title}</title> : null}{P[name]}</svg>;
}

/** The RevenueDot mark: an R whose leg is finished by the gold dot. */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-label="RevenueDot" role="img">
      <rect width="32" height="32" fill="#0A0A0A" />
      <g transform="translate(4.4 4) scale(.75)">
        <path d="M8.5 25.5V6.5h7.2a5.5 5.5 0 010 11H8.5M14.6 17.5l2.2 2.6" fill="none" stroke="#FAFAFA" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="22" cy="23.6" r="3.2" fill="#F7B500" />
      </g>
    </svg>
  );
}
