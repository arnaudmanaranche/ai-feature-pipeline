// Same tokens as docs/index.html, so the video and the docs page read as one brand.
export const theme = {
  bg: '#0f0f0f',
  bgRaised: '#161616',
  line: '#262626',
  lineSoft: '#1c1c1c',
  textHi: '#e4e0dd',
  textLo: '#b7b2ac',
  textMuted: '#9da2a9',

  accent: '#fc7840',
  pass: '#6fae6f',
  retry: '#d9a441',
  halt: '#e2645a',

  fontUi: "'Archivo', Arial, Helvetica, sans-serif",
  fontSerif: "'Source Serif', Georgia, 'Times New Roman', serif",
  fontMono: "'Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
} as const;

export const STAGES = [
  { code: '01', label: 'PM', short: 'Scope' },
  { code: '02', label: 'Dev Review', short: 'Clarify' },
  { code: '03', label: 'Architect', short: 'Design' },
  { code: '04', label: 'Dev', short: 'Build' },
  { code: '05', label: 'Review', short: 'Review' },
  { code: '06', label: 'QA', short: 'Verify' },
  { code: '07', label: 'Retro', short: 'Learn' },
] as const;
