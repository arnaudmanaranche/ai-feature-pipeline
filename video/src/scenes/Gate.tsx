import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { theme } from '../theme';
import { fadeIn, fadeOut, riseIn } from '../anim';

// 120 frames (4s). A concrete gate moment: FAIL, one retry, then PASS.
export const Gate: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const failIn = fadeIn(frame, 0, 12);
  const failOut = fadeOut(frame, 40, 14);
  const failRise = riseIn(frame, 0, 12);

  const retryIn = fadeIn(frame, 46, 12);
  const retryOut = fadeOut(frame, 74, 12);

  const passIn = fadeIn(frame, 82, 14);
  const passRise = riseIn(frame, 82, 14);
  const passPulse = spring({ frame: Math.max(0, frame - 82), fps, config: { damping: 12, mass: 0.6 } });

  return (
    <AbsoluteFill style={{ background: theme.bg, alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', opacity: failIn * failOut, transform: `translateY(${failRise}px)`, textAlign: 'center' }}>
        <div style={{ width: 14, height: 14, borderRadius: '50%', background: theme.halt, margin: '0 auto 26px' }} />
        <div style={{ fontFamily: theme.fontUi, fontSize: 64, color: theme.halt, fontWeight: 600 }}>Review: FAIL</div>
        <div style={{ fontFamily: theme.fontSerif, fontSize: 32, color: theme.textLo, marginTop: 16 }}>
          feeds back to Dev
        </div>
      </div>

      <div style={{ position: 'absolute', opacity: retryIn * retryOut, textAlign: 'center' }}>
        <div style={{ fontFamily: theme.fontMono, fontSize: 34, color: theme.retry, letterSpacing: '0.05em' }}>
          one retry, not an infinite loop
        </div>
      </div>

      <div style={{ position: 'absolute', opacity: passIn, transform: `translateY(${passRise}px) scale(${0.9 + passPulse * 0.1})`, textAlign: 'center' }}>
        <div style={{ width: 14, height: 14, borderRadius: '50%', background: theme.pass, margin: '0 auto 26px' }} />
        <div style={{ fontFamily: theme.fontUi, fontSize: 64, color: theme.pass, fontWeight: 600 }}>Review: PASS</div>
        <div style={{ fontFamily: theme.fontSerif, fontSize: 32, color: theme.textLo, marginTop: 16 }}>
          the PR opens
        </div>
      </div>
    </AbsoluteFill>
  );
};
