import { Composition } from 'remotion';
import { Teaser } from './Teaser';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Teaser"
      component={Teaser}
      durationInFrames={840}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
