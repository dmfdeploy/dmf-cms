import type { Config } from 'tailwindcss'

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        panel: 'var(--panel)',
        accent: 'var(--accent)',
        warning: 'var(--warning)',
        muted: 'var(--muted)',
        text: 'var(--text)',
      },
    },
  },
  plugins: [],
} satisfies Config
