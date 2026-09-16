import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'rimworld',
    include: ['test/**/*.test.ts'],
  },
})
