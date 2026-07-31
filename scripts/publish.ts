import { publish } from '@vitejs/release-scripts'

await publish({
  defaultPackage: '@thednp/rpc',
  packageManager: 'pnpm',
  getPkgDir() {
    return '.'
  },
})
