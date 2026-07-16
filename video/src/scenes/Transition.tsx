import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring } from 'remotion';
import { theme } from '../theme';
import { fadeOut } from '../anim';

// 60 frames (2s). The pivot line before the rail walkthrough begins.
export const Transition: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({ frame, fps, config: { damping: 14, mass: 0.7 } });
  const outOpacity = fadeOut(frame, 45, 14);

  return (
    <AbsoluteFill
      style={{
        background: theme.bg,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: outOpacity,
      }}
    >
      <div
        style={{
          fontFamily: theme.fontUi,
          fontSize: 64,
          color: theme.textHi,
          transform: `scale(${0.9 + scale * 0.1})`,
          opacity: scale,
        }}
      >
        Relay runs it like a team.
      </div>
    </AbsoluteFill>
  );
};
