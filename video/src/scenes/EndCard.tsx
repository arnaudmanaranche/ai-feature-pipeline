import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { theme } from '../theme';
import { fadeIn, fadeOut, riseIn } from '../anim';
import { OrbitBackdrop } from '../OrbitBackdrop';

// 90 frames (3s). Wordmark + thesis line, fading to black for a clean loop.
export const EndCard: React.FC = () => {
  const frame = useCurrentFrame();

  const wordIn = fadeIn(frame, 0, 16);
  const wordRise = riseIn(frame, 0, 16);
  const lineIn = fadeIn(frame, 18, 16);
  const lineRise = riseIn(frame, 18, 16);
  const tagIn = fadeIn(frame, 36, 16);
  const outOpacity = fadeOut(frame, 72, 18);

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
            fontFamily: theme.fontUi,
            fontSize: 96,
            color: theme.textHi,
            opacity: wordIn,
            transform: `translateY(${wordRise}px)`,
          }}
        >
          Relay
        </div>
        <div
          style={{
            fontFamily: theme.fontSerif,
            fontSize: 40,
            color: theme.textLo,
            marginTop: 22,
            opacity: lineIn,
            transform: `translateY(${lineRise}px)`,
            textAlign: 'center',
          }}
        >
          Seven roles. One PR. Zero unreviewed diffs.
        </div>
        <div
          style={{
            fontFamily: theme.fontMono,
            fontSize: 22,
            color: theme.textMuted,
            marginTop: 34,
            opacity: tagIn,
            letterSpacing: '0.03em',
          }}
        >
          github.com/arnaudmanaranche/ai-feature-pipeline
        </div>
      </div>
    </AbsoluteFill>
  );
};
