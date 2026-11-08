/** Ring of N segments that fill as the person turns; each segment = one captured angle. */
export function TurnRing({ degrees, segments = 12, size = 132 }: { degrees: number; segments?: number; size?: number }) {
  const r = size / 2 - 8;
  const c = size / 2;
  const step = 360 / segments;
  const gap = 4;
  const arc = (a0: number, a1: number) => {
    const p = (a: number) => [c + r * Math.sin((a * Math.PI) / 180), c - r * Math.cos((a * Math.PI) / 180)];
    const [x0, y0] = p(a0);
    const [x1, y1] = p(a1);
    return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`;
  };
  const pct = Math.min(100, Math.round((degrees / 360) * 100));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="drop-shadow-[0_0_12px_rgba(0,0,0,0.6)]">
      {Array.from({ length: segments }, (_, i) => {
        const a0 = i * step + gap / 2;
        const a1 = (i + 1) * step - gap / 2;
        const fill = Math.max(0, Math.min(1, (degrees - i * step) / step));
        return (
          <g key={i}>
            <path d={arc(a0, a1)} stroke="rgba(255,255,255,0.18)" strokeWidth={7} fill="none" strokeLinecap="round" />
            {fill > 0 && (
              <path d={arc(a0, a0 + (a1 - a0) * fill)} stroke={fill >= 1 ? "#34d399" : "#a7f3d0"} strokeWidth={7} fill="none" strokeLinecap="round" />
            )}
          </g>
        );
      })}
      <text x={c} y={c - 2} textAnchor="middle" fontSize={26} fontWeight={600} fill="white">{pct}%</text>
      <text x={c} y={c + 18} textAnchor="middle" fontSize={11} fill="rgba(255,255,255,0.6)">{Math.round(degrees)}°</text>
    </svg>
  );
}
