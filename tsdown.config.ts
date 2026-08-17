/**
 * tsdown 配置：双产物构建。
 * - 宿主半侧 lib/index.js：ESM + d.ts。schemastery 不打包（Loader 校验 Config
 *   schema 时必须看到自己的 schemastery 实例）；exceljs/papaparse 不打包，
 *   安装时随 dependencies 解析（exceljs 体量大且有 node 内部依赖，内联易碎）。
 * - 浏览器半侧 lib/client.js：CJS，由 dsh 宿主在 /plugins/<id>/client.js 提供，
 *   以 window.__ModuleLoader__.load 包装头尾；React/Cordis 等 dsh 平台模块表
 *   中的模块一律外部化。
 */
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-geo-viewer'

/** dsh web shell 注入冻结模块表的平台模块。 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** 从 loader 模块表解析的外部依赖。 */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, '@deepseek-ai/dsh-client-runtime/client']

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      neverBundle: [
        '@deepseek-ai/schemastery', '@deepseek-ai/cordis',
        'exceljs', 'papaparse',
      ],
    },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
