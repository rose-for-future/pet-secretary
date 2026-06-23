import { defineConfig } from 'vitest/config'

// 大脑 eval 专用配置：只跑 *.eval.ts（真打 API、非确定性，不进 npm test）。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.eval.ts'],
    testTimeout: 20000
  }
})
