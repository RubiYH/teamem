import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        border: 'hsl(var(--border))',
        muted: 'hsl(var(--muted))',
        'muted-foreground': 'hsl(var(--muted-foreground))',
        panel: 'hsl(var(--panel))',
        primary: 'hsl(var(--primary))',
        'primary-foreground': 'hsl(var(--primary-foreground))'
      },
      boxShadow: {
        panel: '0 18px 50px hsl(26 32% 3% / 0.36)'
      },
      borderRadius: {
        md: '0.5rem',
        sm: '0.375rem'
      }
    }
  },
  plugins: []
};

export default config;
