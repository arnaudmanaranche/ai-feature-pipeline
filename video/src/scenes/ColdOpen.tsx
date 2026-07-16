import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { theme } from '../theme';
import { fadeIn, fadeOut, riseIn } from '../anim';
import { OrbitBackdrop } from '../OrbitBackdrop';

// 90 frames (3s). A small accent dot resolves into the wordmark and kicker.
export const ColdOpen: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const dotScale = spring({ frame, fps, config: { damping: 12, mass: 0.6 } });
  const wordOpacity = fadeIn(frame, 12, 18);
  const wordRise = riseIn(frame, 12, 18);
  const kickerOpacity = fadeIn(frame, 30, 18);
  const outOpacity = fadeOut(frame, 75, 15);

  return (
    <AbsoluteFill
      style={{
        background: theme.bg,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: outOpacity,
      }}
    >
      <OrbitBackdrop cx={960} cy={540} />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div
          style={{
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: theme.accent,
            marginBottom: 28,
            transform: `scale(${dotScale})`,
          }}
        />
        <div
          style={{
            fontFamily: theme.fontUi,
            fontSize: 108,
            color: theme.textHi,
            opacity: wordOpacity,
            transform: `translateY(${wordRise}px)`,
            letterSpacing: '0.01em',
          }}
        >
          Relay
        </div>
        <div
          style={{
            fontFamily: theme.fontUi,
            fontSize: 26,
            fontWeight: 500,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: theme.textMuted,
            marginTop: 22,
            opacity: kickerOpacity,
          }}
        >
          an AI feature pipeline
        </div>
      </div>
    </AbsoluteFill>
  );
};
