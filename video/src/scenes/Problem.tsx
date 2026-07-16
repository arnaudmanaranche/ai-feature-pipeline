import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { theme } from '../theme';
import { fadeIn, fadeOut, riseIn } from '../anim';

// 120 frames (4s). Two beats stating the problem Relay exists to solve.
export const Problem: React.FC = () => {
  const frame = useCurrentFrame();

  const line1In = fadeIn(frame, 0, 15);
  const line1Rise = riseIn(frame, 0, 15);
  const line1Out = fadeOut(frame, 45, 15);

  const line2In = fadeIn(frame, 58, 15);
  const line2Rise = riseIn(frame, 58, 15);

  return (
    <AbsoluteFill
      style={{
        background: theme.bg,
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 220px',
      }}
    >
      <div
        style={{
          position: 'absolute',
          fontFamily: theme.fontSerif,
          fontSize: 58,
          color: theme.textHi,
          textAlign: 'center',
          lineHeight: 1.3,
          opacity: line1In * line1Out,
          transform: `translateY(${line1Rise}px)`,
        }}
      >
        AI agents default to the shortest path from prompt to diff.
      </div>
      <div
        style={{
          fontFamily: theme.fontUi,
          fontSize: 50,
          fontWeight: 600,
          color: theme.textHi,
          textAlign: 'center',
          lineHeight: 1.4,
          opacity: line2In,
          transform: `translateY(${line2Rise}px)`,
        }}
      >
        No scoping.
        <br />
        No review.
        <br />
        No memory of what was tried before.
      </div>
    </AbsoluteFill>
  );
};
