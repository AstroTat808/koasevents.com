export const venueloomBrand = {
  name: 'VenueLoom',
  descriptor: 'Venue Operations Platform',
  tagline: 'The operating system for independent event venues.',
  message: 'From inquiry to event day, weave every part of your venue into one system.',
  colors: {
    ink: '#18242B',
    threadBlue: '#4357F5',
    loomTeal: '#18A999',
    spoolGold: '#D8A84E',
    canvas: '#F7F5EF',
    white: '#FFFFFF',
    slate: '#59636A',
  },
  typography: {
    ui: 'Manrope',
    display: 'Fraunces',
    fallbacks: {
      ui: 'Inter, ui-sans-serif, system-ui, sans-serif',
      display: 'Georgia, Times New Roman, serif',
    },
  },
  radii: {
    card: '20px',
    control: '12px',
    pill: '999px',
  },
} as const;

export type VenueLoomBrand = typeof venueloomBrand;
