import type { SVGProps } from "react";

const paths = {
  arrow: "M5 12h14m-6-6 6 6-6 6",
  check: "m5 12 4 4L19 6",
  camera: "M14 5h-4L8 8H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-4l-2-3ZM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  hanger: "M10 6a2 2 0 1 1 3 1.7L12 9v2L3 17a1 1 0 0 0 .6 1.8h16.8a1 1 0 0 0 .6-1.8l-9-6",
  sparkle: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z",
  spin: "M20 7v5h-5M4 17v-5h5M5.4 8a7 7 0 0 1 11.5-3L20 8M4 16l3.1 3A7 7 0 0 0 18.6 16",
  upload: "M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5",
  search: "m20 20-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z",
  shirt: "m8 3-6 4 3 5 3-2v11h8V10l3 2 3-5-6-4a4 4 0 0 1-8 0Z",
} as const;

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: keyof typeof paths }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name]} /></svg>;
}
