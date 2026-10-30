export const colors = {
  paper: '#f5f2eb',
  ink: '#203b3e',
  muted: '#56615d',
  rule: '#d7d8cf',
  accent: '#95754d',
  light: '#e6e8de',
  secondaryOnInk: '#d0d7ce',
  dividerOnInk: 'rgba(245,242,235,0.25)',
}

export const fonts = {
  serif: "Georgia, 'Times New Roman', serif",
  body: 'Arial, Helvetica, sans-serif',
}

export const eyebrowStyle = {
  fontFamily: fonts.body,
  fontSize: '11px',
  letterSpacing: '0.17em',
  textTransform: 'uppercase' as const,
  color: colors.muted,
  fontWeight: 400,
  margin: '0 0 8px',
}
