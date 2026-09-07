import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const defaults = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export function ArrowUpRight(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M7 17 17 7M8 7h9v9" /></svg>;
}

export function Check(props: IconProps) {
  return <svg {...defaults} {...props}><path d="m5 12 4 4L19 6" /></svg>;
}

export function ChevronDown(props: IconProps) {
  return <svg {...defaults} {...props}><path d="m7 10 5 5 5-5" /></svg>;
}

export function Copy(props: IconProps) {
  return <svg {...defaults} {...props}><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>;
}

export function Refresh(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M20 7v5h-5M4 17v-5h5" /><path d="M18.1 9A7 7 0 0 0 6.5 6.5L4 9m16 6-2.5 2.5A7 7 0 0 1 5.9 15" /></svg>;
}

export function Shield(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M12 3 5 6v5c0 4.8 2.8 8 7 10 4.2-2 7-5.2 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></svg>;
}

export function Unlock(props: IconProps) {
  return <svg {...defaults} {...props}><rect x="4" y="10" width="16" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 7.7-1.5" /></svg>;
}

export function Wallet(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M4 6.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a3 3 0 0 1-3-3v-11a3 3 0 0 1 3-3h11v4" /><path d="M15 13h5M16 13h.01" /></svg>;
}

export function X(props: IconProps) {
  return <svg {...defaults} {...props}><path d="m6 6 12 12M18 6 6 18" /></svg>;
}
