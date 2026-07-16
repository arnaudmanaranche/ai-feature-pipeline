import { useEffect } from 'react';
import { continueRender, delayRender, staticFile } from 'remotion';

// Blocks rendering of each frame until the three embedded fonts have
// actually loaded, so a still/frame render never silently falls back to a
// system font.
const FONT_PROBES = [
  '400 24px Archivo',
  '700 24px Archivo',
  '400 24px "Source Serif"',
  '600 24px "Source Serif"',
  '400 16px "Plex Mono"',
  '600 16px "Plex Mono"',
];

export const useFontsLoaded = () => {
  useEffect(() => {
    const handle = delayRender('Loading fonts');
    Promise.all(FONT_PROBES.map((f) => document.fonts.load(f)))
      .then(() => document.fonts.ready)
      .then(() => continueRender(handle))
      .catch(() => continueRender(handle));
  }, []);
};

// Injected once at the composition root. Same three families as docs/index.html:
// Archivo (UI/body/headline), Source Serif (section-level headings), Plex Mono (code).
export const FontFaces: React.FC = () => (
  <style>{`
    @font-face {
      font-family: 'Archivo';
      font-weight: 100 900;
      font-style: normal;
      src: url('${staticFile('fonts/archivo.woff2')}') format('woff2');
    }
    @font-face {
      font-family: 'Source Serif';
      font-weight: 100 900;
      font-style: normal;
      src: url('${staticFile('fonts/source-serif.woff2')}') format('woff2');
    }
    @font-face {
      font-family: 'Plex Mono';
      font-weight: 400;
      font-style: normal;
      src: url('${staticFile('fonts/plex-mono-400.woff2')}') format('woff2');
    }
    @font-face {
      font-family: 'Plex Mono';
      font-weight: 600;
      font-style: normal;
      src: url('${staticFile('fonts/plex-mono-600.woff2')}') format('woff2');
    }
  `}</style>
);
