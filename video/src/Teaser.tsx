import { AbsoluteFill, Sequence } from 'remotion';
import { FontFaces, useFontsLoaded } from './Fonts';
import { theme } from './theme';
import { ColdOpen } from './scenes/ColdOpen';
import { Problem } from './scenes/Problem';
import { Transition } from './scenes/Transition';
import { Rail } from './scenes/Rail';
import { Gate } from './scenes/Gate';
import { EndCard } from './scenes/EndCard';

// 840 frames @ 30fps = 28s.
const SCENES = [
  { Component: ColdOpen, from: 0, duration: 90 },
  { Component: Problem, from: 90, duration: 120 },
  { Component: Transition, from: 210, duration: 60 },
  { Component: Rail, from: 270, duration: 360 },
  { Component: Gate, from: 630, duration: 120 },
  { Component: EndCard, from: 750, duration: 90 },
];

export const Teaser: React.FC = () => {
  useFontsLoaded();

  return (
    <AbsoluteFill style={{ background: theme.bg, fontFamily: theme.fontUi }}>
      <FontFaces />
      {SCENES.map(({ Component, from, duration }) => (
        <Sequence key={from} from={from} durationInFrames={duration}>
          <Component />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
