import { AbsoluteFill, useCurrentFrame, Easing, interpolate, spring, useVideoConfig } from 'remotion';
import { theme, STAGES } from '../theme';
import { fadeIn } from '../anim';

const N = STAGES.length;
const RAIL_Y = 460;
const X_START = 260;
const X_END = 1660;
const nodeX = (i: number) => X_START + (i * (X_END - X_START)) / (N - 1);

// 360 frames (12s). The centerpiece: a dot travels the rail, lighting each
// stage in turn while a large callout below names the current stage.
export const Rail: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const segLen = 360 / N;

  // arrival[i]: frame at which stage i is considered "lit". Stage 0 pops in
  // near the start; stages 1..N-1 arrive at the midpoint of their segment,
  // after traveling from the previous node during the segment's first half.
  const arrival = STAGES.map((_, i) => (i === 0 ? 10 : i * segLen + segLen * 0.5));

  let currentIndex = 0;
  for (let i = 0; i < N; i++) {
    if (frame >= arrival[i]) currentIndex = i;
  }

  // Traveling dot: only visible while inside a travel window (first half of
  // stage i's segment, i>=1).
  let dotX: number | null = null;
  for (let i = 1; i < N; i++) {
    const segStart = i * segLen;
    const segArrive = arrival[i];
    if (frame >= segStart && frame <= segArrive) {
      const t = interpolate(frame, [segStart, segArrive], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: Easing.inOut(Easing.cubic),
      });
      dotX = nodeX(i - 1) + (nodeX(i) - nodeX(i - 1)) * t;
    }
  }

  const localSinceArrival = frame - arrival[currentIndex];
  const calloutIn = fadeIn(localSinceArrival, 0, 12);
  const pulse = spring({
    frame: Math.max(0, localSinceArrival),
    fps,
    config: { damping: 11, mass: 0.5 },
  });

  const current = STAGES[currentIndex];

  return (
    <AbsoluteFill style={{ background: theme.bg }}>
      {/* rail line */}
      <div
        style={{
          position: 'absolute',
          left: X_START,
          right: 1920 - X_END,
          top: RAIL_Y,
          height: 1,
          background: theme.line,
        }}
      />

      {/* nodes */}
      {STAGES.map((s, i) => {
        const lit = frame >= arrival[i];
        const isActive = i === currentIndex;
        const size = isActive ? 20 : 12;
        const color = !lit ? theme.line : isActive ? theme.accent : theme.textMuted;
        const scale = isActive ? 0.7 + pulse * 0.3 : 1;
        return (
          <div key={s.code}>
            <div
              style={{
                position: 'absolute',
                left: nodeX(i) - size / 2,
                top: RAIL_Y - size / 2,
                width: size,
                height: size,
                borderRadius: '50%',
                background: lit ? color : theme.bg,
                border: `1.5px solid ${color}`,
                transform: `scale(${scale})`,
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: nodeX(i) - 60,
                top: RAIL_Y + 22,
                width: 120,
                textAlign: 'center',
                fontFamily: theme.fontUi,
                fontSize: 18,
                color: lit ? theme.textLo : theme.line,
                opacity: fadeIn(frame, arrival[i], 10),
              }}
            >
              {s.label}
            </div>
          </div>
        );
      })}

      {/* traveling dot */}
      {dotX !== null && (
        <div
          style={{
            position: 'absolute',
            left: dotX - 7,
            top: RAIL_Y - 7,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: theme.accent,
            boxShadow: `0 0 18px 2px ${theme.accent}`,
          }}
        />
      )}

      {/* current-stage callout */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 640,
          textAlign: 'center',
          opacity: calloutIn,
          transform: `translateY(${(1 - calloutIn) * 16}px)`,
        }}
      >
        <div
          style={{
            fontFamily: theme.fontMono,
            fontSize: 24,
            color: theme.textMuted,
            marginBottom: 14,
          }}
        >
          Stage {current.code}
        </div>
        <div
          style={{
            fontFamily: theme.fontUi,
            fontSize: 96,
            color: theme.textHi,
          }}
        >
          {current.label}
        </div>
        <div
          style={{
            fontFamily: theme.fontSerif,
            fontSize: 44,
            color: theme.accent,
            marginTop: 10,
          }}
        >
          {current.short}
        </div>
      </div>
    </AbsoluteFill>
  );
};
