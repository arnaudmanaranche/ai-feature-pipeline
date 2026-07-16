import { useCurrentFrame } from 'remotion';
import { theme } from './theme';

// Faint dashed concentric rings, echoing the hero graphic on docs/index.html.
// Decorative only, sits behind title cards, drifting very slowly.
export const OrbitBackdrop: React.FC<{ cx: number; cy: number }> = ({ cx, cy }) => {
  const frame = useCurrentFrame();
  const rotation = frame * 0.05;
  const radii = [90, 150, 210, 270];

  return (
    <svg
      width="100%"
      height="100%"
      style={{ position: 'absolute', inset: 0 }}
      viewBox="0 0 1920 1080"
    >
      <g transform={`rotate(${rotation} ${cx} ${cy})`}>
        {radii.map((r) => (
          <circle
            key={r}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={theme.textMuted}
            strokeOpacity={0.22}
            strokeDasharray="1.5 7"
          />
        ))}
      </g>
    </svg>
  );
};
